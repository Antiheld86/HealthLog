/**
 * v1.5.0 — worker-side adapters for the canonical recurrence engine.
 *
 * Bridges the Prisma `Medication` + `MedicationSchedule` row shape the
 * reminder worker reads against `src/lib/medications/scheduling/recurrence.ts`'s
 * `CanonicalSchedule` + `RecurrenceContext` shapes. Keeps the worker file
 * focused on phase math + dispatch and concentrates the cadence-decoding
 * surface in one small, easily unit-testable module.
 *
 * Closes the pre-existing `intervalWeeks` bi-weekly bug
 * (`grep intervalWeeks src/lib/jobs/reminder-worker.ts` returned zero
 * hits before v1.5) by routing every "does today emit a slot?"
 * decision through the canonical engine. The engine prefers the new
 * `rrule` field, falls back to the legacy `daysOfWeek` string only
 * when neither `rrule` nor `rollingIntervalDays` are populated — and
 * the legacy fallback path now honours `intervalWeeks > 1`, which the
 * pre-v1.5 worker did not.
 */
import {
  type CanonicalSchedule,
  type DoseWindowEntry,
  type RecurrenceContext,
  type ScheduleType,
  occurrencesBetween,
} from "@/lib/medications/scheduling/recurrence";
import {
  hhmmToMinutes,
  hhmmToMinutesOrNull,
} from "@/lib/medications/scheduling/hhmm";
import { DOSE_WINDOW_DEFAULTS } from "@/lib/medications/scheduling/dose-window-defaults";

/**
 * Minimal Prisma-shape projection used by the worker. Mirrors the
 * fields the canonical engine consumes from a `MedicationSchedule`
 * row — kept narrow so a caller can `select` exactly these columns
 * without pulling the full Prisma type.
 */
export interface WorkerScheduleRow {
  id: string;
  windowStart: string;
  windowEnd: string;
  daysOfWeek: string | null;
  timesOfDay: string[];
  reminderGraceMinutes: number | null;
  rrule: string | null;
  rollingIntervalDays: number | null;
  /**
   * v1.7.0 — schedule-type + cyclic phase. The Prisma column is the
   * `MedicationScheduleType` enum (string-valued at runtime), so a plain
   * string assignment matches `ScheduleType`. Rows selected before the
   * v1.7.0 read-flip that omit these fields default to SCHEDULED via the
   * adapter below.
   */
  scheduleType?: ScheduleType | null;
  cyclicOnWeeks?: number | null;
  cyclicOffWeeks?: number | null;
  /**
   * v1.15.18 — per-dose on-time windows. The Prisma column is `Json?`, so a
   * selected row surfaces it as `Prisma.JsonValue` (or `null`). The adapter
   * normalises it to a `DoseWindowEntry[]` (dropping malformed entries) so the
   * band minter never has to defend against an arbitrary JSON shape.
   */
  doseWindows?: unknown;
}

/** Minimal `Medication` projection used by the worker. */
export interface WorkerMedicationRow {
  id: string;
  startsOn: Date | null;
  endsOn: Date | null;
  oneShot: boolean;
  createdAt: Date;
}

/**
 * Adapt a Prisma `MedicationSchedule` row to the canonical engine's
 * `CanonicalSchedule` shape. Pure / synchronous; no DB access.
 */
export function buildCanonicalSchedule(
  schedule: WorkerScheduleRow,
): CanonicalSchedule {
  return {
    id: schedule.id,
    rrule: schedule.rrule,
    rollingIntervalDays: schedule.rollingIntervalDays,
    timesOfDay: schedule.timesOfDay,
    daysOfWeek: schedule.daysOfWeek,
    windowStart: schedule.windowStart,
    windowEnd: schedule.windowEnd,
    reminderGraceMinutes: schedule.reminderGraceMinutes,
    scheduleType: schedule.scheduleType ?? "SCHEDULED",
    cyclicOnWeeks: schedule.cyclicOnWeeks ?? null,
    cyclicOffWeeks: schedule.cyclicOffWeeks ?? null,
    doseWindows: normaliseDoseWindows(schedule.doseWindows),
  };
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * v1.15.18 — coerce the persisted `dose_windows` JSON into a clean
 * `DoseWindowEntry[]`. Drops anything that isn't an `{ timeOfDay, start, end }`
 * triple of well-formed HH:mm strings with `start <= end` — the column is
 * Zod-validated on write, but a hand-edited or legacy row must never crash the
 * read/write band paths. Returns `null` (the default-derivation signal) when
 * nothing usable survives.
 */
export function normaliseDoseWindows(raw: unknown): DoseWindowEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DoseWindowEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { timeOfDay, start, end } = item as Record<string, unknown>;
    if (
      typeof timeOfDay !== "string" ||
      typeof start !== "string" ||
      typeof end !== "string" ||
      !HHMM_RE.test(timeOfDay) ||
      !HHMM_RE.test(start) ||
      !HHMM_RE.test(end) ||
      hhmmToMinutes(start) > hhmmToMinutes(end)
    ) {
      continue;
    }
    out.push({ timeOfDay, start, end });
  }
  return out.length > 0 ? out : null;
}

/** Build the canonical engine context from worker-loop state. */
export function buildRecurrenceContext(input: {
  medication: WorkerMedicationRow;
  userTz: string;
  lastIntakeAt: Date | null;
}): RecurrenceContext {
  return {
    medication: {
      id: input.medication.id,
      startsOn: input.medication.startsOn,
      endsOn: input.medication.endsOn,
      oneShot: input.medication.oneShot,
      createdAt: input.medication.createdAt,
    },
    timeZone: input.userTz,
    lastIntakeAt: input.lastIntakeAt,
  };
}

/**
 * Does the schedule emit at least one occurrence somewhere in
 * `[todayStart, todayEnd]`? The reminder worker calls this once per
 * `(medication, schedule)` pair on each 15-minute tick — replaces the
 * legacy weekday-only filter (`recurrence.daysOfWeek.length > 0 &&
 * !recurrence.daysOfWeek.includes(todayDow)`) at
 * `src/lib/jobs/reminder-worker.ts:514`.
 *
 * Honours every cadence the canonical engine supports:
 *   - one-shot (only true on the medication's `startsOn` day)
 *   - rolling (true when `lastIntakeAt + N days` lands inside today)
 *   - RRULE (true when today is a matching weekday/monthday/etc.)
 *   - legacy `daysOfWeek` string (with `intervalWeeks > 1` honoured —
 *     the pre-v1.5 worker silently dropped this; v1.5 closes the bug)
 *   - `endsOn` cap (false after the course ends)
 *
 * Pure; no DB access. The caller threads `lastIntakeAt` and `userTz`
 * in via `buildRecurrenceContext`.
 */
export function scheduleEmitsInWindow(
  schedule: CanonicalSchedule,
  ctx: RecurrenceContext,
  windowStart: Date,
  windowEnd: Date,
): boolean {
  return occurrencesBetween(schedule, windowStart, windowEnd, ctx).length > 0;
}

/**
 * Per-slot phase-window duration, in minutes: how long after a dose
 * slot's own start time it stays "on-time" before the reminder tick
 * starts escalating through ORANGE/RED, and (halved) the radius a
 * logged dose must land within to suppress that slot's reminder.
 *
 * Bug this closes: the reminder tick used to compute this ONCE per
 * schedule as the whole schedule's `windowEnd - windowStart` span and
 * apply that SAME span to every `timeOfDay` slot in the schedule. That
 * is correct for a single-time-of-day schedule (the span already IS
 * that one slot's window), but for a multi-time-of-day schedule it
 * silently inflates every slot's grace period to the full gap between
 * the schedule's earliest and latest dose. A twice-daily schedule with
 * `windowStart=08:00`/`windowEnd=18:00` (representing "somewhere
 * between the morning and evening dose", not a per-dose window) gave
 * its 08:00 slot a 600-minute (10h) grace before it even entered
 * ORANGE — silently far too lenient — while a schedule with a single
 * `08:00` dose and the same-looking `windowEnd=09:00` correctly used a
 * 60-minute span, and thus a 30-minute suppression radius that a dose
 * logged more than 30 minutes late could never satisfy — far too
 * strict. Same misapplied field, opposite-looking symptoms.
 *
 * A multi-time-of-day schedule must NOT get a different answer than a
 * single-time-of-day one for a dose configured the same way — the
 * point of this function is that the count of sibling slots on the
 * schedule never changes one slot's own resolved duration except
 * through the explicit, bounded inter-slot-overlap guard in tier 4
 * below (which only ever narrows, and only when slots truly are close
 * enough together to otherwise overlap).
 *
 * Four-tier resolution, checked in priority order — the first
 * applicable tier wins, each strictly a "the user configured this
 * exact thing" tier before falling back to a shared default:
 *
 *  1. An explicit per-dose `doseWindows` entry for THIS `slotTime`
 *     (`{ timeOfDay, start, end }`, persisted by the dose-window
 *     editor — v1.15.18) is the actual rule the user set for this
 *     specific dose in the GUI. Its `end - start` (in minutes) is
 *     used directly. Independent of every other dose on the
 *     schedule, by construction — this is a per-`timeOfDay` lookup.
 *  2. `reminderGraceMinutes`, when set, is used directly. The field
 *     already exists and is documented ("Replaces the implicit
 *     windowEnd - windowStart span for late-classification") for
 *     exactly this purpose, and the write-path already reads it via
 *     `graceToleranceMs` — but the reminder tick itself never read
 *     it, so setting it had no effect on when/whether a reminder
 *     fired. This is a schedule-wide override, applied identically
 *     to every slot on the schedule (the field itself is per-schedule,
 *     not per-dose, so uniform application here is what the value
 *     represents — not a slot-count-dependent choice).
 *  3. With NEITHER of the above set, this dose has no explicit
 *     configuration at all, and gets the same default an unconfigured
 *     "point" dose gets everywhere else in the app (`defaultBandForTime`
 *     in `dose-window.ts`, `±DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes`).
 *     Deliberately NOT the legacy per-schedule `windowEnd - windowStart`
 *     span here: for a multi-time-of-day schedule that span is not a
 *     per-dose window at all — it was derived as the earliest and
 *     latest `timeOfDay` (see the bug writeup above), so an
 *     unconfigured dose on a two-dose schedule must not silently
 *     inherit a multi-hour gap purely because it has a sibling.
 *  4. Bounded by the minimum gap between adjacent sorted `timesOfDay`
 *     (the midnight wrap counted as one of those gaps) whenever the
 *     schedule has more than one slot, so two distinct same-day doses
 *     can never share a window — this can only ever narrow tiers 1-3,
 *     never widen them, and is a no-op for a single-time-of-day
 *     schedule (nothing to overlap with).
 *
 * The one legacy exception, preserved for backward compatibility: a
 * single-time-of-day schedule with none of tiers 1-2 set keeps using
 * the literal `windowEnd - windowStart` span rather than tier 3's
 * default — for a schedule that predates the per-dose `doseWindows`
 * system (v1.15.18), that legacy span IS the one and only window the
 * user configured for that dose, and reinterpreting it as "unconfigured"
 * would silently narrow an intentionally wide window on every such
 * pre-existing schedule.
 */
export function resolveSlotWindowDurationMinutes(
  schedule: Pick<
    WorkerScheduleRow,
    "windowStart" | "windowEnd" | "timesOfDay" | "reminderGraceMinutes"
  >,
  slotTime: string,
  doseWindows: DoseWindowEntry[] | null,
): number {
  const explicit = doseWindows?.find((w) => w.timeOfDay === slotTime);
  if (explicit) {
    const startMin = hhmmToMinutesOrNull(explicit.start);
    const endMin = hhmmToMinutesOrNull(explicit.end);
    if (startMin !== null && endMin !== null) {
      let span = endMin - startMin;
      if (span < 0) span += 24 * 60; // overnight window
      return span;
    }
  }

  if (
    typeof schedule.reminderGraceMinutes === "number" &&
    Number.isFinite(schedule.reminderGraceMinutes) &&
    schedule.reminderGraceMinutes > 0
  ) {
    return schedule.reminderGraceMinutes;
  }

  const slots = (
    schedule.timesOfDay && schedule.timesOfDay.length > 0
      ? schedule.timesOfDay
      : [schedule.windowStart]
  )
    .map(hhmmToMinutesOrNull)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);

  let span: number;
  if (slots.length > 1) {
    span = DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes * 2;
  } else {
    const startMin = hhmmToMinutesOrNull(schedule.windowStart);
    const endMin = hhmmToMinutesOrNull(schedule.windowEnd);
    span = startMin === null || endMin === null ? 0 : endMin - startMin;
    if (span < 0) span += 24 * 60; // overnight window
    return span; // single-slot legacy path — no sibling to cap against
  }

  let minGap = Infinity;
  for (let i = 1; i < slots.length; i++) {
    minGap = Math.min(minGap, slots[i] - slots[i - 1]);
  }
  const wrapGap = slots[0] + 24 * 60 - slots[slots.length - 1];
  minGap = Math.min(minGap, wrapGap);
  if (Number.isFinite(minGap) && minGap > 0) {
    span = Math.min(span, minGap);
  }

  return span;
}

/**
 * Minimal Prisma surface the missed-dose guard needs — just a `count`
 * over `MedicationIntakeEvent`. Keeps the helper unit-testable with a
 * tiny fake and the worker passing its real client.
 */
interface IntakeCountClient {
  medicationIntakeEvent: {
    count: (args: { where: Record<string, unknown> }) => Promise<number>;
  };
}

/**
 * v1.8.2 — decide whether the reminder worker should mint a RED-phase
 * pending `REMINDER` row for the given slot.
 *
 * Returns `false` (skip the mint) when the slot already carries either:
 *   - an existing pending `REMINDER` row (P2002-collision avoidance; the
 *     `deletedAt: null` filter is intentionally omitted because a
 *     tombstoned REMINDER row still occupies the `(userId, medicationId,
 *     scheduledFor, source)` unique slot), OR
 *   - an ACTIONED row — `takenAt` set OR `skipped` — from ANY source,
 *     restricted to live rows (`deletedAt: null`). The intake write
 *     paths snap a "Genommen" / "Übersprungen" write onto this exact
 *     canonical slot instant via a source-agnostic update, so a dose the
 *     user acted on before the RED phase opens already has a live
 *     taken/skipped row here. Without this arm the worker would mint a
 *     pending REMINDER row alongside the user's WEB/API taken row — the
 *     duplicate-intake bug — because the two differ by `source` and the
 *     unique index would not collide.
 *
 * `scheduledFor` must be the canonical `localHmAsUtc` slot instant the
 * projector + write paths use, so the existence probes match byte-for-byte.
 */
export async function shouldMintMissedDoseRow(
  client: IntakeCountClient,
  slot: { userId: string; medicationId: string; scheduledFor: Date },
): Promise<boolean> {
  const existingPendingReminder = await client.medicationIntakeEvent.count({
    where: {
      medicationId: slot.medicationId,
      userId: slot.userId,
      scheduledFor: slot.scheduledFor,
      takenAt: null,
      source: "REMINDER",
    },
  });
  if (existingPendingReminder > 0) return false;

  const existingActioned = await client.medicationIntakeEvent.count({
    where: {
      medicationId: slot.medicationId,
      userId: slot.userId,
      scheduledFor: slot.scheduledFor,
      deletedAt: null,
      OR: [{ takenAt: { not: null } }, { skipped: true }],
    },
  });
  return existingActioned === 0;
}
