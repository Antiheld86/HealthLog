/**
 * v1.17.1 — Vorsorge (measurement) reminder dispatcher.
 *
 * Mirrors the mood-reminder cron (`mood-reminder.ts`): a separate module,
 * a pure due-predicate, a `runMeasurementReminderTick(prisma, now)`
 * runner. The cron fires every 15 minutes so it picks up every IANA
 * timezone crossing the reminder's `notifyHour` without one cron entry
 * per zone.
 *
 * Differences from the mood reminder:
 *
 *   1. No dedicated dispatch-ledger table. The reminder's own
 *      `nextDueAt` IS the dedup guard: after a successful dispatch the
 *      runner advances `nextDueAt` to the next occurrence strictly past
 *      now, so the same due cycle never re-fires. This collapses one
 *      table + one cleanup queue versus the mood pattern.
 *   2. Auto-resolve from an incoming measurement. Before deciding to
 *      fire, the runner checks whether a matching reading of the
 *      reminder's `measurementType` has landed since the last satisfy
 *      (BP matched on `BLOOD_PRESSURE_SYS`). If so it advances
 *      `lastSatisfiedAt` + recomputes `nextDueAt` and skips the nudge —
 *      the user who already measured today never gets nagged. This is a
 *      query in the cron, NOT a hook on the hot iOS batch-ingest path.
 *      Free-text reminders (no `measurementType`) never auto-resolve;
 *      they advance only on a manual satisfy.
 *   3. `notificationPrefs.measurementReminder.clientManaged` suppresses the
 *      server-side APNs send only, and it does so in the dispatcher — the
 *      tick dispatches for every user and lets the cascade decide.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { MeasurementType } from "@/generated/prisma/client";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { defaultLocale, locales } from "@/lib/i18n/config";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { getEvent } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import type { ModuleKey } from "@/lib/modules/registry";
import {
  computeReminderNextDueAt,
  type ReminderScheduleInput,
} from "@/lib/measurement-reminders/scheduling";
import { findSatisfyingEvent } from "@/lib/measurement-reminders/resolve";
import { satisfyReminder } from "@/lib/measurement-reminders/satisfy";

/**
 * v1.18.0 — map a reminder's `measurementType` to the toggleable module
 * that owns it, or `null` when the type is a CORE domain (weight, blood
 * pressure, pulse, body composition) or has no module of its own. A
 * `null` reminder type (free-text Vorsorge entry) also yields `null`.
 *
 * Only the secondary-domain types carry a gate: glucose, sleep, and the
 * mental-wellbeing screenings (v1.27.6 — the PHQ-9 / GAD-7 module is
 * opt-in, so a screening reminder must fall silent the moment the module
 * is off). Everything else is core and dispatches regardless — disabling
 * a module must never silence a core-vital reminder.
 */
function moduleForMeasurementType(
  type: MeasurementType | null,
): ModuleKey | null {
  switch (type) {
    case "BLOOD_GLUCOSE":
      return "glucose";
    case "SLEEP_DURATION":
      return "sleep";
    case "PHQ9_SCORE":
    case "GAD7_SCORE":
    case "WHO5_SCORE":
    case "SCI_SCORE":
      return "mentalHealth";
    default:
      return null;
  }
}

/**
 * Slack added to `now` when scanning for due reminders, so a `nextDueAt`
 * stamped just ahead of a tick still falls inside the same hour window.
 * One tick interval (15 min) — small enough that the in-Node hour gate stays
 * the authoritative fire decision.
 */
const DUE_QUERY_SLACK_MS = 15 * 60_000;

export interface MeasurementReminderSummary {
  candidatesScanned: number;
  inWindow: number;
  dispatched: number;
  autoResolved: number;
  skippedNotDue: number;
  skippedOutsideWindow: number;
  skippedModuleDisabled: number;
  skippedNoChannel: number;
  /** v1.18.1 — expired COACH course-window reminders soft-deleted this tick. */
  expiredCleaned: number;
  failed: number;
}

/**
 * v1.18.1 — soft-delete COACH course-window reminders whose finite window
 * has elapsed. A Coach-suggested protocol (the ESH/AHA 7-day BP cadence)
 * carries a non-NULL `endsOn`; once the recurrence engine walks past it the
 * row's `nextDueAt` is stamped NULL (no future occurrence). Such a row can
 * never fire again, so it would otherwise linger forever in the Vorsorge
 * list as a dead "completed course". Tombstone it so the surface stays
 * clean. Scoped to `origin: COACH` so a user's open-ended VORSORGE row with
 * a one-shot `endsOn` is never touched without intent.
 */
async function cleanupExpiredCoachReminders(
  prisma: PrismaClient,
  now: Date,
): Promise<number> {
  const result = await prisma.measurementReminder.updateMany({
    where: {
      deletedAt: null,
      origin: "COACH",
      endsOn: { not: null, lt: now },
      nextDueAt: null,
    },
    data: { deletedAt: now },
  });
  return result.count;
}

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/**
 * Pure due-predicate: at this instant, is the reminder due AND inside its
 * local notify-hour window?
 *
 * "Due" = `nextDueAt != null` and `now >= nextDueAt`. The hour gate keeps
 * a reminder that became overdue overnight from firing at 03:00 — it
 * waits for the user's chosen `notifyHour` to come round in their local
 * timezone. Pulled out so the unit tests can pin the window boundary
 * (08:59 → no, 09:00 → yes, 09:59 → yes, 10:00 → no) without the DB.
 */
export function evaluateMeasurementReminderDue(
  reminder: {
    enabled: boolean;
    nextDueAt: Date | null;
    notifyHour: number;
  },
  timezone: string,
  now: Date,
): { fire: boolean; inHourWindow: boolean; isDue: boolean } {
  if (!reminder.enabled || reminder.nextDueAt === null) {
    return { fire: false, inHourWindow: false, isDue: false };
  }
  const isDue = now.getTime() >= reminder.nextDueAt.getTime();
  const parts = wallClockInTz(now, timezone || "Europe/Berlin");
  const inHourWindow = parts.hour === reminder.notifyHour;
  return { fire: isDue && inHourWindow, inHourWindow, isDue };
}

/**
 * Build the localised title + body for the Vorsorge push.
 */
export function buildMeasurementReminderPayload(
  locale: string | null | undefined,
  label: string,
  location: string | null,
): { title: string; body: string } {
  const t = getServerTranslator(resolveLocale(locale)).t;
  const base = t("measurementReminders.pushBody", { label });
  const body = location
    ? `${base} ${t("measurementReminders.pushLocation", { location })}`
    : base;
  return { title: t("measurementReminders.pushTitle"), body };
}

/**
 * Run one Vorsorge-reminder cron tick. Iterates every live, enabled
 * reminder, auto-resolves the typed ones against incoming readings,
 * and dispatches a `MEASUREMENT_REMINDER` push for any that are due
 * inside the user's local notify-hour window.
 */
export async function runMeasurementReminderTick(
  prisma: PrismaClient,
  now: Date,
  options: {
    dispatch?: typeof dispatchNotification;
    /**
     * v1.18.0 module gate — injectable so the unit tests pin the
     * disabled-module skip without the gate's DB reads. Defaults to the
     * real `isModuleEnabled` resolver.
     */
    isModuleEnabled?: typeof isModuleEnabled;
  } = {},
): Promise<MeasurementReminderSummary> {
  const dispatchImpl = options.dispatch ?? dispatchNotification;
  const moduleGate = options.isModuleEnabled ?? isModuleEnabled;

  const summary: MeasurementReminderSummary = {
    candidatesScanned: 0,
    inWindow: 0,
    dispatched: 0,
    autoResolved: 0,
    skippedNotDue: 0,
    skippedOutsideWindow: 0,
    skippedModuleDisabled: 0,
    skippedNoChannel: 0,
    expiredCleaned: 0,
    failed: 0,
  };

  // v1.18.1 — sweep expired COACH course-window reminders before scanning
  // the due set, so a self-expired protocol drops out of the list and the
  // dispatch loop never re-evaluates a row that can never fire again.
  summary.expiredCleaned = await cleanupExpiredCoachReminders(prisma, now);

  // Bound the scan to reminders that could plausibly fire this tick so Postgres
  // uses `measurement_reminders_user_id_next_due_at_idx` instead of loading the
  // whole cross-tenant enabled set 4×/hour. `nextDueAt` is stamped at the
  // notify-hour boundary, so anything due is already <= now; the small slack
  // (one tick interval) covers a stamp landing just ahead of a :00 tick. A
  // null `nextDueAt` is a non-recurring reminder that can never fire — the
  // in-Node `evaluateMeasurementReminderDue` short-circuits it anyway, so
  // excluding it here is parity. Reminders satisfied early re-anchor once they
  // cross due, before any nudge fires, so dropping future rows is safe.
  const dueFloor = new Date(now.getTime() + DUE_QUERY_SLACK_MS);
  const reminders = await prisma.measurementReminder.findMany({
    where: {
      deletedAt: null,
      enabled: true,
      nextDueAt: { not: null, lte: dueFloor },
    },
    include: {
      user: {
        select: {
          id: true,
          timezone: true,
          locale: true,
        },
      },
    },
  });

  for (const reminder of reminders) {
    summary.candidatesScanned += 1;
    try {
      const timezone = reminder.user.timezone || "Europe/Berlin";

      // ── Auto-resolve from an incoming event ────────────────────────
      // Cheap safety-net poll, in the cron (the eventful `reminder-satisfy`
      // worker is the fast path). A typed reminder resolves from a matching
      // Measurement; a free-text reminder resolves from a LabResult (the
      // Lab↔Vorsorge link). Both go through the shared `findSatisfyingEvent`
      // + `satisfyReminder` primitives so the cron and the worker can never
      // diverge. A reading inside the current due cycle means the user
      // already measured — re-anchor + skip the nudge.
      const satisfiedAt = await findSatisfyingEvent(
        prisma,
        reminder.user.id,
        reminder,
      );
      if (satisfiedAt) {
        const result = await satisfyReminder(
          prisma,
          reminder,
          timezone,
          satisfiedAt,
        );
        if (result.satisfied) {
          summary.autoResolved += 1;
          continue;
        }
      }

      const decision = evaluateMeasurementReminderDue(
        {
          enabled: reminder.enabled,
          nextDueAt: reminder.nextDueAt,
          notifyHour: reminder.notifyHour,
        },
        timezone,
        now,
      );

      if (!decision.isDue) {
        summary.skippedNotDue += 1;
        continue;
      }
      if (!decision.inHourWindow) {
        summary.skippedOutsideWindow += 1;
        continue;
      }

      summary.inWindow += 1;

      // v1.18.0 module gate — a reminder whose measurement type belongs to
      // a toggleable module (glucose / sleep) must not fire once the user
      // turns that module off. Core-vital reminders (weight / BP / pulse /
      // body comp) and free-text reminders map to no module and are never
      // gated. Checked after the due + window gates so the gate read only
      // fires for reminders that would otherwise dispatch this tick.
      const gatedModule = moduleForMeasurementType(reminder.measurementType);
      if (
        gatedModule !== null &&
        !(await moduleGate(reminder.user.id, gatedModule))
      ) {
        getEvent()?.addMeta(
          "measurement_reminder.skipped_module_disabled",
          `${reminder.id}:${gatedModule}`,
        );
        summary.skippedModuleDisabled += 1;
        // Advance past this cycle so a disabled-module reminder does not pin
        // the server tick re-evaluating the same overdue slot every 15
        // minutes for the rest of the day. The user turned the module off,
        // so there is nothing this reminder could still deliver.
        await advanceNextDue(prisma, reminder, timezone, now);
        continue;
      }

      // `measurementReminder.clientManaged` is NOT consulted here. It
      // suppresses the server's APNs send only — the dispatcher's APNs
      // branch owns that decision and emits the
      // `measurement_reminder.suppressed_client_managed` annotation per
      // skip. The tick used to suppress every channel AND advance
      // `nextDueAt`, so a preventive-care reminder that never reached the
      // user was filed as handled and vanished from the card and the digest.
      // Now, when nothing delivers, the no-channel branch below leaves the
      // reminder overdue and visible.
      const { title, body } = buildMeasurementReminderPayload(
        reminder.user.locale,
        reminder.label,
        reminder.location,
      );
      const renderForRecipient = (locale: Locale) => {
        const rendered = buildMeasurementReminderPayload(
          locale,
          reminder.label,
          reminder.location,
        );
        return { title: rendered.title, message: rendered.body };
      };

      const outcome = await dispatchImpl({
        eventType: "MEASUREMENT_REMINDER",
        userId: reminder.user.id,
        title,
        message: body,
        renderForRecipient,
        metadata: {
          scheduledAt: now.toISOString(),
          reminderId: reminder.id,
        },
      });

      // No channel succeeded — leave `nextDueAt` where it is so the next
      // tick (or the user's next channel) retries. The reminder simply
      // stays overdue, which the surface already shows as "überfällig".
      if (!outcome.dispatched) {
        summary.skippedNoChannel += 1;
        continue;
      }

      // Dispatch succeeded — advance `nextDueAt` past now so this due
      // cycle never re-fires (the ledger-free dedup guard).
      await advanceNextDue(prisma, reminder, timezone, now);
      summary.dispatched += 1;
    } catch (err: unknown) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      getEvent()?.addWarning(
        `measurement-reminder per-reminder dispatch failed for ${reminder.id}: ${message}`,
      );
    }
  }

  return summary;
}

export interface ReminderSatisfySummary {
  candidatesScanned: number;
  satisfied: number;
  skippedModuleDisabled: number;
  skippedNoEvent: number;
  failed: number;
}

/**
 * v1.18.1 — eventful satisfaction for one user. Called by the
 * `reminder-satisfy` worker right after a measurement / lab write lands
 * (from any ingest path: manual create, batch, or a device sync). The
 * 15-min cron remains the idempotent safety-net behind this.
 *
 * Loads the user's live, enabled reminders that could auto-resolve (typed
 * → a Measurement; free-text → a LabResult), and for each runs the SAME
 * `findSatisfyingEvent` + `satisfyReminder` primitives the cron uses, so
 * "I just weighed myself, stop reminding me" resolves immediately instead
 * of waiting up to 15 minutes.
 *
 * Respects the module toggle: a reminder whose measurement type belongs to
 * a disabled module produces no engine activity (the same gate the cron
 * dispatch applies). Forward-only `satisfyReminder` makes a duplicate
 * enqueue + the trailing cron poll converge without double-stamping.
 */
export async function runReminderSatisfyForUser(
  prisma: PrismaClient,
  userId: string,
  now: Date,
  options: { isModuleEnabled?: typeof isModuleEnabled } = {},
): Promise<ReminderSatisfySummary> {
  void now;
  const moduleGate = options.isModuleEnabled ?? isModuleEnabled;

  const summary: ReminderSatisfySummary = {
    candidatesScanned: 0,
    satisfied: 0,
    skippedModuleDisabled: 0,
    skippedNoEvent: 0,
    failed: 0,
  };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const timezone = user?.timezone || "Europe/Berlin";

  const reminders = await prisma.measurementReminder.findMany({
    where: { userId, deletedAt: null, enabled: true },
  });

  for (const reminder of reminders) {
    summary.candidatesScanned += 1;
    try {
      // Module toggle — no engine activity for a reminder whose type
      // belongs to a disabled module. Core-vital + free-text reminders map
      // to no module and are never gated.
      const gatedModule = moduleForMeasurementType(reminder.measurementType);
      if (gatedModule !== null && !(await moduleGate(userId, gatedModule))) {
        summary.skippedModuleDisabled += 1;
        continue;
      }

      const satisfiedAt = await findSatisfyingEvent(prisma, userId, reminder);
      if (!satisfiedAt) {
        summary.skippedNoEvent += 1;
        continue;
      }

      const result = await satisfyReminder(
        prisma,
        reminder,
        timezone,
        satisfiedAt,
      );
      if (result.satisfied) {
        summary.satisfied += 1;
        getEvent()?.addMeta(
          "measurement_reminder.satisfied_eventful",
          reminder.id,
        );
      } else {
        // Forward-only no-op — the cron or a prior enqueue already
        // advanced this row past the event.
        summary.skippedNoEvent += 1;
      }
    } catch (err: unknown) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      getEvent()?.addWarning(
        `reminder-satisfy per-reminder resolve failed for ${reminder.id}: ${message}`,
      );
    }
  }

  return summary;
}

/**
 * Advance `nextDueAt` to the next occurrence strictly after `now`. Used
 * after a successful dispatch (and after a client-managed skip) as the
 * ledger-free dedup guard. Does NOT touch `lastSatisfiedAt` — a fired
 * reminder is not "satisfied", it just rolls to its next slot.
 */
async function advanceNextDue(
  prisma: PrismaClient,
  reminder: {
    id: string;
    intervalDays: number | null;
    rrule: string | null;
    anchorDate: Date | null;
    notifyHour: number;
    lastSatisfiedAt: Date | null;
    createdAt: Date;
  },
  timezone: string,
  now: Date,
): Promise<void> {
  // The dedup guard must move the slot strictly forward. For an `rrule`
  // the engine already walks to the next strictly-after-now occurrence,
  // so passing the row as-is is correct. For a ROLLING reminder the
  // engine anchors the first-due slot AT `anchorDate ?? createdAt` when
  // never satisfied, which stays ≤ now and would re-fire every tick — so
  // re-anchor the rolling cadence on `now` (a fire is the rhythm
  // restarting from this dispatch) to roll it forward by exactly one
  // interval. This does NOT advance `lastSatisfiedAt`: a fired reminder
  // is not satisfied, just rescheduled past the slot it nagged on.
  const rolling = reminder.intervalDays !== null;
  const scheduleInput: ReminderScheduleInput = {
    intervalDays: reminder.intervalDays,
    rrule: reminder.rrule,
    anchorDate: reminder.anchorDate,
    notifyHour: reminder.notifyHour,
    lastSatisfiedAt: rolling ? now : reminder.lastSatisfiedAt,
    createdAt: reminder.createdAt,
  };
  const nextDueAt = computeReminderNextDueAt(scheduleInput, timezone, now);
  await prisma.measurementReminder.update({
    where: { id: reminder.id },
    data: { nextDueAt },
  });
}
