/**
 * Medication-reminder check: the 15-minute tick that finds due and overdue intakes, mints missed-dose rows, escalates phases, and dispatches notifications. Also prunes scheduled Telegram deletions.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { recordError, recordReminderCheck } from "@/lib/jobs/worker-status";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";
import { decrypt } from "@/lib/crypto";
import { withBackgroundEvent } from "@/lib/logging/background";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { medicationDoseTag } from "@/lib/notifications/dose-tag";
import { buildBandsForMedication } from "@/lib/medications/scheduling/band-minter";
import { attributeIntakeToSlot } from "@/lib/medications/scheduling/attribution";
import { nearestAnchorBand } from "@/lib/medications/scheduling/dose-history";
import { occurrencesBetween } from "@/lib/medications/scheduling/recurrence";
import {
  buildCanonicalSchedule,
  buildRecurrenceContext,
  resolveSlotPhaseWindow,
  scheduleEmitsInWindow,
  shouldMintMissedDoseRow,
} from "@/lib/medications/scheduling/worker-helpers";
import { deleteMessage } from "@/lib/telegram";
import {
  DEFAULT_PHASE_CONFIG,
  resolvePhaseThresholds,
  determinePhase,
  getPhaseMessage,
  getPhaseKeyboard,
} from "@/lib/jobs/reminder-phases";
import {
  hasReminderDedupAnchor,
  medicationReminderDedupKey,
  writeReminderDedupAnchor,
} from "@/lib/notifications/reminder-dedup";
import {
  getUserTodayBounds as getUserTodayBoundsUtil,
  localHmAsUtc,
} from "@/lib/tz/local-day";
import { getWorkerPrisma, parseTimeToMinutes } from "./shared";

export interface ReminderCheckPayload {
  triggeredAt: string;
}

const getUserTodayBounds = getUserTodayBoundsUtil;

/**
 * Process expired TelegramScheduledDeletion records.
 * Deletes messages from Telegram and removes the DB records.
 * Called at the start of every reminder check (every 15 minutes).
 */
export async function cleanupScheduledTelegramDeletions(): Promise<void> {
  const prisma = getWorkerPrisma();
  try {
    let totalDeleted = 0;

    // Process in batches until all expired records are handled
    while (true) {
      const expired = await prisma.telegramScheduledDeletion.findMany({
        where: { deleteAfter: { lte: new Date() } },
        take: 100,
      });

      if (expired.length === 0) break;

      // Group by userId to fetch bot token once per user
      const byUser = new Map<
        string,
        { chatId: string; messageId: number; id: string }[]
      >();
      for (const record of expired) {
        const list = byUser.get(record.userId) ?? [];
        list.push({
          chatId: record.chatId,
          messageId: record.messageId,
          id: record.id,
        });
        byUser.set(record.userId, list);
      }

      const deletedIds: string[] = [];
      for (const [userId, messages] of byUser) {
        const user = await prisma.user.findFirst({
          where: { id: userId, telegramBotToken: { not: null } },
          select: { telegramBotToken: true },
        });
        if (!user?.telegramBotToken) {
          // No bot token — just clean up the records
          deletedIds.push(...messages.map((m) => m.id));
          continue;
        }
        const botToken = decrypt(user.telegramBotToken);
        for (const msg of messages) {
          try {
            await deleteMessage(botToken, msg.chatId, msg.messageId);
          } catch {
            // Best-effort: message may already be deleted
          }
          deletedIds.push(msg.id);
        }
      }

      if (deletedIds.length > 0) {
        await prisma.telegramScheduledDeletion.deleteMany({
          where: { id: { in: deletedIds } },
        });
        totalDeleted += deletedIds.length;
      }
    }

    if (totalDeleted > 0) {
      const { getEvent } = await import("@/lib/logging/context");
      getEvent()?.addMeta("telegram_scheduled_cleanup", totalDeleted);
    }

    // v1.19.0 — prune expired force-reply correlation rows in the same
    // tick (no new sweep). An unanswered mood-note prompt leaves a
    // TelegramPromptContext row; once past `expiresAt` it can never bind a
    // reply, so drop it. The prompt MESSAGE itself self-cleans through the
    // scheduled-deletion rows above.
    const prunedContexts = await prisma.telegramPromptContext.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    if (prunedContexts.count > 0) {
      const { getEvent } = await import("@/lib/logging/context");
      getEvent()?.addMeta(
        "telegram_prompt_context_cleanup",
        prunedContexts.count,
      );
    }
  } catch (err) {
    const { getEvent } = await import("@/lib/logging/context");
    getEvent()?.addWarning(`telegram-scheduled-cleanup failed: ${err}`);
  }
}

/**
 * Check all active medications for each user and determine reminder phases.
 * Uses phase-based logic (GREEN/YELLOW/ORANGE/RED) to send one notification
 * per phase transition rather than every 15 minutes.
 */
export async function handleReminderCheck(jobs: Job<ReminderCheckPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.medication_reminder", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      recordReminderCheck();
      const now = new Date();

      // Clean up expired scheduled Telegram message deletions
      await cleanupScheduledTelegramDeletions();

      // Clean up expired snoozes
      await prisma.medication.updateMany({
        where: { snoozedUntil: { lt: now } },
        data: { snoozedUntil: null },
      });

      // Get all active medications with schedules and phase config.
      // v1.16.11 — as-needed (PRN) medications never remind: they carry
      // zero schedules anyway (the per-schedule loop below would be a
      // no-op), but the explicit predicate keeps them out of the tick's
      // per-medication intake reads entirely.
      const medications = await prisma.medication.findMany({
        where: { active: true, asNeeded: false },
        include: {
          schedules: true,
          phaseConfig: true,
          scheduleRevisions: {
            where: { supersededByRevisionId: null },
            orderBy: { validUntil: "desc" },
            take: 1,
            select: { validUntil: true },
          },
          user: {
            select: {
              id: true,
              timezone: true,
              // Used to localise the reminder title / message / keyboard
              // labels per user. Null falls back to the app default.
              locale: true,
            },
          },
        },
      });

      for (const med of medications) {
        const userTz = med.user.timezone || "Europe/Berlin";
        const { start: todayStart, end: todayEnd } = getUserTodayBounds(
          now,
          userTz,
        );

        // Get today's date string in user's timezone for message tracking
        const localDateStr = now.toLocaleDateString("sv-SE", {
          timeZone: userTz,
        }); // YYYY-MM-DD format

        // v1.7.0 code-correctness M4 — fetch today's intake events so a
        // logged dose suppresses the reminder for the SLOT it belongs to,
        // not a positional running counter. The pre-v1.7 code suppressed
        // by `eventCount > schedulesProcessed`, which attributed a logged
        // morning dose to whichever slot iterated first; with an unsorted
        // `timesOfDay = ["20:00","08:00"]` that suppressed the evening
        // reminder while the morning still fired. We match by time-of-day
        // proximity instead. Worker-minted RED placeholders (takenAt null,
        // not skipped, source REMINDER) are NOT a user action, so they are
        // excluded from the suppression set.
        const todayEvents = await prisma.medicationIntakeEvent.findMany({
          where: {
            medicationId: med.id,
            userId: med.user.id,
            // v1.7.0 sync — a tombstoned dose is no longer a logged
            // action, so it must not suppress today's reminder.
            deletedAt: null,
            scheduledFor: { gte: todayStart, lte: todayEnd },
          },
          select: {
            scheduledFor: true,
            takenAt: true,
            skipped: true,
            attributionSource: true,
            updatedAt: true,
          },
        });
        // The worker reminds only the live schedule rows. The newest active
        // revision ended when that live era began, so actions performed
        // before its boundary belong to the archived cadence and cannot
        // suppress a slot minted from today's replacement schedule. Explicit
        // skips and USER_PIN decisions are mutations, whose Prisma @updatedAt
        // timestamp records the decision. Ordinary takes use their takenAt.
        const liveEraStart =
          med.scheduleRevisions?.[0]?.validUntil.getTime() ?? null;
        const liveEraEvents =
          liveEraStart === null
            ? todayEvents
            : todayEvents.filter((event) => {
                const actionAt =
                  event.skipped || event.attributionSource === "USER_PIN"
                    ? event.updatedAt
                    : event.takenAt;
                return actionAt !== null && actionAt.getTime() >= liveEraStart;
              });
        const anchoredActionSlotInstants = liveEraEvents.flatMap((event) => {
          if (event.skipped) return [event.scheduledFor];
          if (
            event.takenAt !== null &&
            event.attributionSource === "USER_PIN" &&
            event.scheduledFor.getTime() !== event.takenAt.getTime()
          ) {
            return [event.scheduledFor];
          }
          return [];
        });
        const takenDoseInstants = liveEraEvents.flatMap((event) =>
          event.takenAt !== null &&
          !event.skipped &&
          event.attributionSource !== "USER_PIN"
            ? [event.takenAt]
            : [],
        );

        const phaseConfig = med.phaseConfig ?? DEFAULT_PHASE_CONFIG;

        // Each anchored or attributed action can suppress only one schedule
        // row, including when separate rows emit at the same instant.
        const claimedAnchoredActionIndexes = new Set<number>();
        const claimedTakenDoseIndexes = new Set<number>();

        const sortedSchedules = [...med.schedules].sort((a, b) =>
          a.windowStart.localeCompare(b.windowStart),
        );

        // v1.5.0 — fetch the latest `takenAt` for this medication
        // once per tick when any schedule on it is rolling. The
        // canonical recurrence engine needs `lastIntakeAt` to compute
        // the next-due instant for rolling cadences; calendar
        // cadences ignore the field, so the fetch is conditional to
        // avoid an extra round-trip on the common path. Failures bias
        // toward "treat as never logged" so a flaky DB doesn't
        // suppress reminders.
        const hasRollingSchedule = med.schedules.some(
          (s) => s.rollingIntervalDays !== null,
        );
        let lastIntakeAt: Date | null = null;
        if (hasRollingSchedule) {
          const lastIntake = await prisma.medicationIntakeEvent.findFirst({
            where: {
              userId: med.user.id,
              medicationId: med.id,
              // v1.7.0 sync — a tombstoned intake no longer anchors the
              // rolling-interval next-due computation.
              deletedAt: null,
              takenAt: { not: null },
            },
            orderBy: { takenAt: "desc" },
            select: { takenAt: true },
          });
          lastIntakeAt = lastIntake?.takenAt ?? null;
        }

        const canonicalSchedules = sortedSchedules.map(buildCanonicalSchedule);
        const recurrenceCtx = buildRecurrenceContext({
          medication: med,
          userTz,
          lastIntakeAt,
        });

        // Attribute every action against one medication-wide pool. Each
        // schedule still mints its own cadence-aware bands, preserving its
        // late-tail shape, while the attribution primitive resolves overlaps
        // by status and nearest anchor across all schedule rows.
        //
        // The retrospective rolling minter normally omits the still-open
        // forward occurrence. Seed each rolling mint with the recurrence
        // engine's actual open slot for this day. This keeps skipped rows,
        // whose action instant is scheduledFor, attributable without treating
        // a skip as the next cadence anchor.
        const pooledOwnedSlotBands = canonicalSchedules.flatMap(
          (canonicalSchedule) => {
            const rollingOpenSlots =
              canonicalSchedule.rollingIntervalDays === null
                ? []
                : occurrencesBetween(
                    canonicalSchedule,
                    todayStart,
                    todayEnd,
                    recurrenceCtx,
                  ).map((occurrence) => occurrence.at);
            const bands = buildBandsForMedication({
              medication: med,
              schedule: canonicalSchedule,
              ctx: recurrenceCtx,
              userTz,
              range: { from: todayStart, to: todayEnd },
              now,
              intakeInstants: rollingOpenSlots,
            }).bands;
            return bands
              .filter(
                (band) =>
                  liveEraStart === null || band.at.getTime() >= liveEraStart,
              )
              .map((band) => ({
                scheduleId: canonicalSchedule.id,
                band,
              }));
          },
        );
        const pooledSlotBands = pooledOwnedSlotBands.map((owned) => owned.band);
        const scheduleIdByBand = new Map(
          pooledOwnedSlotBands.map((owned) => [owned.band, owned.scheduleId]),
        );
        const attributedAnchoredActionSlots = anchoredActionSlotInstants.map(
          (instant) => {
            const band = nearestAnchorBand(instant, pooledSlotBands);
            const scheduleId = band ? scheduleIdByBand.get(band) : undefined;
            return band && scheduleId
              ? { scheduleId, slotInstant: band.at.getTime() }
              : null;
          },
        );
        const attributedTakenDoseSlots = takenDoseInstants.map((instant) => {
          const band = attributeIntakeToSlot(instant, pooledSlotBands)?.band;
          const scheduleId = band ? scheduleIdByBand.get(band) : undefined;
          return band && scheduleId
            ? { scheduleId, slotInstant: band.at.getTime() }
            : null;
        });

        for (
          let scheduleIndex = 0;
          scheduleIndex < sortedSchedules.length;
          scheduleIndex++
        ) {
          const schedule = sortedSchedules[scheduleIndex];
          const canonicalSchedule = canonicalSchedules[scheduleIndex];
          // v1.5.0 — route every "does today emit a slot?" decision
          // through the canonical recurrence engine. Replaces the
          // legacy weekday-only filter that silently ignored
          // `intervalWeeks` (the pre-v1.5 bi-weekly bug — a Wed
          // bi-weekly schedule fired every Wed instead of every other
          // Wed). The engine honours RRULE / rolling / one-shot /
          // legacy-with-interval-weeks / `endsOn` cap; no special-
          // casing here.
          if (
            !scheduleEmitsInWindow(
              canonicalSchedule,
              recurrenceCtx,
              todayStart,
              todayEnd,
            )
          ) {
            continue;
          }

          // v1.7.0 SB-SCHED-4 — multi-time-of-day dispatch. A schedule
          // with `timesOfDay = ["08:00","20:00"]` is two distinct dose
          // slots per day; the pre-v1.7 worker keyed phase + dedup on the
          // single `windowStart`, so the evening dose never reminded.
          // Each slot resolves its own phase bounds. Logged-dose suppression
          // uses the same dose bands as intake attribution and history.
          //
          // The legacy single-window contract is preserved: a schedule
          // with no first-class `timesOfDay` emits exactly one slot at
          // `windowStart` with `timeOfDay = ""`, which dedupes against
          // pre-v1.7 rows (backfilled to "") byte-for-byte.
          const nowMs = now.getTime();

          const hasFirstClassTimes =
            schedule.timesOfDay && schedule.timesOfDay.length > 0;
          // v1.7.0 code-correctness M4 — iterate slots in chronological
          // order so phase/dedup/suppression decisions are deterministic
          // and a logged dose maps to the nearest slot, not whichever the
          // stored array order happened to surface first.
          const slotTimes = (
            hasFirstClassTimes
              ? [...schedule.timesOfDay]
              : [schedule.windowStart]
          ).sort((a, b) => parseTimeToMinutes(a) - parseTimeToMinutes(b));

          for (const slotTime of slotTimes) {
            // Dedup key time-of-day: "" for a legacy single-window
            // schedule (byte-stable against pre-v1.7 rows), else the
            // explicit HH:mm.
            const dedupTimeOfDay = hasFirstClassTimes ? slotTime : "";
            // The UTC instant this slot is due (DST-safe).
            const [slotH, slotM] = slotTime.split(":").map(Number);
            const slotScheduledFor = localHmAsUtc(now, userTz, slotH, slotM);
            const slotInstant = slotScheduledFor.getTime();
            if (liveEraStart !== null && slotInstant < liveEraStart) {
              continue;
            }
            const phaseWindow = resolveSlotPhaseWindow(
              schedule,
              slotTime,
              canonicalSchedule.doseWindows ?? null,
              slotScheduledFor,
              userTz,
            );
            const minutesFromStart =
              (nowMs - phaseWindow.start.getTime()) / 60_000;
            const minutesToEnd = (phaseWindow.end.getTime() - nowMs) / 60_000;
            const windowDuration =
              (phaseWindow.end.getTime() - phaseWindow.start.getTime()) /
              60_000;

            // Skips and retained USER_PIN takes bind to the nearest canonical
            // anchor inside the dose-history epsilon. A released pin has
            // scheduledFor === takenAt and is deliberately ad-hoc, so it was
            // excluded above.
            let anchoredActionIdx = -1;
            for (let ai = 0; ai < attributedAnchoredActionSlots.length; ai++) {
              if (claimedAnchoredActionIndexes.has(ai)) continue;
              const attributed = attributedAnchoredActionSlots[ai];
              if (
                attributed?.scheduleId !== canonicalSchedule.id ||
                attributed.slotInstant !== slotInstant
              ) {
                continue;
              }
              anchoredActionIdx = ai;
              break;
            }
            if (anchoredActionIdx >= 0) {
              claimedAnchoredActionIndexes.add(anchoredActionIdx);
              continue;
            }

            // Taken actions do not necessarily land exactly on their slot, so
            // they use medication-wide pooled band attribution.
            let matchedIdx = -1;
            let matchedDist = Infinity;
            for (let li = 0; li < takenDoseInstants.length; li++) {
              if (claimedTakenDoseIndexes.has(li)) continue;
              const attributed = attributedTakenDoseSlots[li];
              if (
                attributed?.scheduleId !== canonicalSchedule.id ||
                attributed.slotInstant !== slotInstant
              ) {
                continue;
              }
              const distance = Math.abs(
                takenDoseInstants[li].getTime() - slotInstant,
              );
              if (distance < matchedDist) {
                matchedDist = distance;
                matchedIdx = li;
              }
            }
            if (matchedIdx >= 0) {
              claimedTakenDoseIndexes.add(matchedIdx);
              continue;
            }

            // Skip if medication is snoozed
            if (med.snoozedUntil && now < med.snoozedUntil) {
              continue;
            }

            // Resolve phase thresholds
            const thresholds = resolvePhaseThresholds(
              phaseConfig,
              windowDuration,
            );

            // Determine current phase for this slot's window.
            const currentPhase = determinePhase(
              minutesToEnd,
              minutesFromStart,
              thresholds,
            );

            if (!currentPhase) {
              continue;
            }

            // Already notified for this slot, phase and local day? The
            // anchor lives in `push_attempts` and is stamped for every
            // dispatched slot regardless of which channels delivered. It
            // used to be the Telegram message ledger, which is written only
            // when a Telegram send succeeds — so a user on email / APNs /
            // ntfy had no row and the tick re-sent the same overdue notice
            // every 15 minutes for the rest of the day.
            const dedupReason = medicationReminderDedupKey({
              medicationId: med.id,
              scheduleId: schedule.id,
              slotTime,
              phase: currentPhase,
              localDate: localDateStr,
            });

            if (
              await hasReminderDedupAnchor(prisma, {
                userId: med.user.id,
                eventType: "MEDICATION_REMINDER",
                reason: dedupReason,
                now,
              })
            ) {
              continue;
            }

            const doseInfo = schedule.dose ?? med.dose;
            const timeWindow = `${slotTime}`;

            // RED phase: create missed intake event for this slot.
            if (currentPhase === "RED") {
              // v1.8.2 — gate the missed-dose mint through the shared
              // guard. It refuses to mint when the slot already carries an
              // existing pending REMINDER row (P2002-collision avoidance,
              // tombstones included) OR an ACTIONED row (taken / skipped)
              // from ANY source. The intake write paths snap a "Genommen" /
              // "Übersprungen" write onto the canonical slot instant
              // (source-agnostic update), so a user who acted before the
              // RED phase opens has a live taken/skipped row at this exact
              // slot — minting here would re-create the duplicate the
              // write paths just collapsed.
              const shouldMint = await shouldMintMissedDoseRow(prisma, {
                userId: med.user.id,
                medicationId: med.id,
                scheduledFor: slotScheduledFor,
              });

              if (shouldMint) {
                await prisma.medicationIntakeEvent.create({
                  data: {
                    userId: med.user.id,
                    medicationId: med.id,
                    scheduledFor: slotScheduledFor,
                    takenAt: null,
                    skipped: false,
                    source: "REMINDER",
                  },
                });

                evt.addMeta("missed_dose", `${med.name}:${slotTime}`);

                // v1.4.39 W-MED — refresh the compliance rollup so the
                // per-day `scheduled` count increments before any read.
                await recomputeMedicationComplianceForEvent({
                  userId: med.user.id,
                  medicationId: med.id,
                  scheduledFor: slotScheduledFor,
                  tz: med.user.timezone,
                });
              }
            }

            // Send notification if enabled.
            //
            // `medication.clientManaged` is NOT consulted here. It suppresses
            // the server's APNs send only — the iOS client owns the local
            // banner, every other channel the user configured still delivers
            // — so the gate lives in the dispatcher's APNs branch, which is
            // the only place that knows whether an APNs send was on the table.
            if (med.notificationsEnabled) {
              const { title, message } = getPhaseMessage(
                currentPhase,
                med.name,
                doseInfo,
                timeWindow,
                Math.ceil(minutesToEnd),
                med.user.locale,
              );

              const keyboard = getPhaseKeyboard(
                currentPhase,
                med.id,
                med.user.locale,
              );

              // v0.5.4 — surface the slot time as an ISO 8601 string so
              // the iOS snooze action pins against the actual slot.
              const scheduledAtIso = slotScheduledFor.toISOString();

              evt.addMeta(
                "notification_phase",
                `${currentPhase}:${med.name}:${slotTime}`,
              );

              // Stamp the dedup anchor BEFORE dispatching: a crash between
              // the two costs this phase's notice, a repeat costs the user
              // a notification every 15 minutes until the day rolls.
              await writeReminderDedupAnchor(prisma, {
                userId: med.user.id,
                eventType: "MEDICATION_REMINDER",
                reason: dedupReason,
              });

              try {
                await dispatchNotification({
                  eventType: "MEDICATION_REMINDER",
                  userId: med.user.id,
                  title,
                  message,
                  metadata: {
                    medicationId: med.id,
                    scheduleId: schedule.id,
                    phase: currentPhase,
                    date: localDateStr,
                    // v1.7.0 SB-SCHED-4 — carry the dedup time-of-day so
                    // the Telegram-message ledger keys per slot.
                    timeOfDay: dedupTimeOfDay,
                    scheduledAt: scheduledAtIso,
                    replyMarkup: keyboard,
                    // v1.18.4 — stable per-slot Web Push tag. The
                    // clear-on-taken push reuses the SAME tag so the SW
                    // replaces/closes this reminder when the dose is logged
                    // (the PWA equivalent of ending a Live Activity), and a
                    // re-fired reminder for the same slot coalesces instead
                    // of stacking on the lock screen. Deep-link clicks land
                    // on the dose's medication page.
                    webPushTag: medicationDoseTag(med.id, scheduledAtIso),
                    url: `/medications/${med.id}`,
                  },
                });
              } catch (notifErr) {
                evt.addWarning(
                  `Notification dispatch failed for ${currentPhase} phase ${med.name}: ${notifErr}`,
                );
              }
            }
          }
        }
      }
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}
