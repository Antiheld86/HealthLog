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
import {
  buildCanonicalSchedule,
  buildRecurrenceContext,
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

        const currentTime = now.toLocaleTimeString("en-GB", {
          timeZone: userTz,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });

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
          select: { scheduledFor: true, takenAt: true, skipped: true },
        });
        const loggedDoseInstants = todayEvents
          .filter((e) => e.takenAt !== null || e.skipped)
          .map((e) => (e.takenAt ?? e.scheduledFor).getTime());

        // Resolve phase configuration
        const phaseConfig = med.phaseConfig ?? DEFAULT_PHASE_CONFIG;

        // Slots a logged dose has already claimed (by index into the
        // chronologically-sorted slotTimes) so one dose can't suppress two.
        const claimedSlotInstants = new Set<number>();

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

        for (const schedule of sortedSchedules) {
          // v1.5.0 — route every "does today emit a slot?" decision
          // through the canonical recurrence engine. Replaces the
          // legacy weekday-only filter that silently ignored
          // `intervalWeeks` (the pre-v1.5 bi-weekly bug — a Wed
          // bi-weekly schedule fired every Wed instead of every other
          // Wed). The engine honours RRULE / rolling / one-shot /
          // legacy-with-interval-weeks / `endsOn` cap; no special-
          // casing here.
          const canonicalSchedule = buildCanonicalSchedule(schedule);
          const recurrenceCtx = buildRecurrenceContext({
            medication: med,
            userTz,
            lastIntakeAt,
          });
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
          // Iterate every first-class time-of-day, each with its own
          // window (anchored at the time, spanning the legacy
          // `windowEnd - windowStart` duration), phase, dedup key
          // (now including the time-of-day), and RED-mint instant.
          //
          // The legacy single-window contract is preserved: a schedule
          // with no first-class `timesOfDay` emits exactly one slot at
          // `windowStart` with `timeOfDay = ""`, which dedupes against
          // pre-v1.7 rows (backfilled to "") byte-for-byte.
          const baseStartMins = parseTimeToMinutes(schedule.windowStart);
          const baseEndMins = parseTimeToMinutes(schedule.windowEnd);
          const windowDuration = baseEndMins - baseStartMins;
          const currentMins = parseTimeToMinutes(currentTime);

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
            const slotStartMins = parseTimeToMinutes(slotTime);
            const slotEndMins = slotStartMins + windowDuration;
            const minutesToEnd = slotEndMins - currentMins;
            const minutesFromStart = currentMins - slotStartMins;

            // The UTC instant this slot is due (DST-safe).
            const [slotH, slotM] = slotTime.split(":").map(Number);
            const slotInstant = localHmAsUtc(
              now,
              med.user.timezone,
              slotH,
              slotM,
            ).getTime();

            // Suppress this slot's reminder if a user-logged dose (taken
            // or skipped) sits within half the window duration of the
            // slot's due time. Matching by proximity — not a positional
            // counter — means a partially-dosed day still reminds for the
            // correct missing slot. Each logged dose claims at most one
            // slot so two slots can't both be suppressed by one dose.
            const matchRadiusMs = Math.max(windowDuration, 60) * 60_000 * 0.5;
            let matchedIdx = -1;
            let matchedDist = Infinity;
            for (let li = 0; li < loggedDoseInstants.length; li++) {
              if (claimedSlotInstants.has(li)) continue;
              const dist = Math.abs(loggedDoseInstants[li] - slotInstant);
              if (dist <= matchRadiusMs && dist < matchedDist) {
                matchedDist = dist;
                matchedIdx = li;
              }
            }
            if (matchedIdx >= 0) {
              claimedSlotInstants.add(matchedIdx);
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

            // DST-safe slot instant, computed once above.
            const slotScheduledFor = new Date(slotInstant);

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
                minutesToEnd,
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
