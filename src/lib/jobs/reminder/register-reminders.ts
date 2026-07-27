/**
 * Reminder-dispatch queue registrar.
 *
 * Owns the user-facing reminder ticks: the medication overdue check, the daily
 * mood reminder, the cycle reminder (period-soon + period-start-confirm), the
 * Vorsorge (measurement) reminder, and the eventful reminder-satisfy queue.
 *
 * v1.4.37 dead-queue contract: every queue name appears in `allQueues`, its
 * cron (where it has one) appears as a `[QUEUE, CRON]` tuple in `schedules`,
 * and a `createAndWork(boss, QUEUE, …, handler)` binding drains it. The
 * `cycle-reminder-queue` and `measurement-reminder-queue` guards read THIS
 * module.
 *
 * Retry policy: every queue here keeps the pg-boss default. These ticks are
 * fan-out passes whose per-user failures never fail the job, so a job-level
 * failure means the pass itself could not run — a transient the default two
 * retries are the right answer to. The satisfy queue carries its own
 * `retryLimit` at send time (see `reminder-satisfy.ts`).
 */
import { PgBoss } from "pg-boss";
import {
  REMINDER_SATISFY_QUEUE,
  REMINDER_SATISFY_CONCURRENCY,
  type ReminderSatisfyPayload,
} from "@/lib/jobs/reminder-satisfy";
import {
  createAndSchedule,
  createAndWork,
  type ScheduleEntry,
} from "./registrar-shared";
import {
  ReminderCheckPayload,
  handleReminderCheck,
} from "./medication-reminder-check";
import {
  MoodReminderPayload,
  CycleReminderPayload,
  MeasurementReminderPayload,
  handleMoodReminderCheck,
  handleCycleReminderCheck,
  handleMeasurementReminderCheck,
  handleReminderSatisfy,
} from "./mood-cycle-checks";

const QUEUE_NAME = "medication-reminder-check";

const CHECK_INTERVAL_CRON = "*/15 * * * *"; // every 15 minutes
// v0.5.4 ios-coord — daily mood-reminder cron.
//
// Runs every 15 minutes so the handler can pick up users whose local
// time has just crossed 22:00 across any IANA timezone without having
// to schedule one cron entry per zone. The handler short-circuits when
// the user's local hour isn't 22, so the 15-min cadence translates to
// ~4 ticks-per-hour × 1 actual-dispatch-window-per-user = at most one
// push per user per day. Idempotency is enforced by the
// `MoodReminderDispatch` ledger inside the handler.

const MOOD_REMINDER_QUEUE = "mood-reminder-check";

const MOOD_REMINDER_CRON = "*/15 * * * *";
// v1.15 — daily cycle reminder cron (period-soon + period-start-confirm).
//
// Runs every 15 minutes for the same reason as the mood reminder: the
// handler short-circuits unless the candidate user's local time is the
// cycle-reminder hour (09:00), so the 15-min cadence picks up every IANA
// timezone crossing that hour without one cron entry per zone. At most one
// push per event per user per local day — the `push_attempts` ledger is the
// idempotency anchor inside the handler.

const CYCLE_REMINDER_QUEUE = "cycle-reminder-check";

const CYCLE_REMINDER_CRON = "*/15 * * * *";

// v1.17.1 — every-15-min tick for Vorsorge (measurement) reminders.
// Same cadence + short-circuit shape as the mood / cycle reminders: the
// handler only fires a reminder whose `nextDueAt` is past AND whose local
// time is the reminder's `notifyHour`, so the 15-min cadence picks up
// every IANA timezone crossing that hour without one cron entry per zone.
// Dedup is the reminder's own `nextDueAt` advance — no ledger table.

const MEASUREMENT_REMINDER_QUEUE = "measurement-reminder-check";

const MEASUREMENT_REMINDER_CRON = "*/15 * * * *";

const allQueues = [
  QUEUE_NAME,
  // v0.5.4 ios-coord — mood-reminder cron tick. Same pg-boss v12
  // createQueue contract as the drain queue; without this entry the
  // every-15-min schedule silently no-ops and the dispatcher never fires.
  MOOD_REMINDER_QUEUE,
  // v1.15 — cycle-reminder cron tick (period-soon + period-start-confirm).
  // Without this entry the every-15-min schedule silently no-ops and the
  // cycle dispatcher never fires (the v1.4.37 dead-queue class).
  CYCLE_REMINDER_QUEUE,
  // v1.17.1 — Vorsorge (measurement) reminder cron tick. Without this entry
  // pg-boss never provisions the queue and the every-15-min schedule
  // silently no-ops (the v1.4.37 dead-queue class).
  MEASUREMENT_REMINDER_QUEUE,
  // v1.18.1 — eventful Vorsorge satisfaction. No cron of its own (the
  // 15-min measurement-reminder check is the safety-net); enqueued by the
  // ingest paths. Must still be registered here or the worker binding
  // below never provisions the queue (v1.4.37 dead-queue lesson).
  REMINDER_SATISFY_QUEUE,
];

const schedules: ScheduleEntry[] = [
  [QUEUE_NAME, CHECK_INTERVAL_CRON],
  // v0.5.4 ios-coord — every-15-min tick for the daily mood reminder.
  // The handler short-circuits unless the candidate user's local
  // time is the 22:00 hour, so the cron costs ~one user-row scan
  // per tick for the entire opted-in cohort.
  [MOOD_REMINDER_QUEUE, MOOD_REMINDER_CRON],
  // v1.15 — every-15-min tick for the daily cycle reminder. The handler
  // short-circuits unless the candidate user's local time is the 09:00
  // hour, so the cron costs ~one prediction-row scan per tick for the
  // opted-in cohort.
  [CYCLE_REMINDER_QUEUE, CYCLE_REMINDER_CRON],
  // v1.17.1 — every-15-min tick for the Vorsorge (measurement) reminder.
  // The handler short-circuits unless a reminder is past-due AND the
  // user's local time matches the reminder's notifyHour, so the cron
  // costs ~one reminder-row scan per tick for the active cohort.
  [MEASUREMENT_REMINDER_QUEUE, MEASUREMENT_REMINDER_CRON],
];

/**
 * Register every reminder-dispatch queue. Returns the queue names created (for
 * the boot-level aggregate assertion).
 */
export async function registerReminderQueues(
  boss: PgBoss,
): Promise<readonly string[]> {
  await createAndSchedule(boss, allQueues, schedules);

  await createAndWork<ReminderCheckPayload>(
    boss,
    QUEUE_NAME,
    { localConcurrency: 1 },
    handleReminderCheck,
  );
  // v0.5.4 ios-coord — single-flight worker. localConcurrency=1 keeps
  // two reminder ticks from interleaving against the same user row;
  // the dedup ledger would still save us, but skipping the race here
  // avoids spurious P2002 errors in the wide-event log.
  await createAndWork<MoodReminderPayload>(
    boss,
    MOOD_REMINDER_QUEUE,
    { localConcurrency: 1 },
    handleMoodReminderCheck,
  );
  // v1.15 — single-flight cycle-reminder worker. localConcurrency=1 keeps
  // two ticks from racing the fire-and-forget `push_attempts` ledger that
  // anchors the per-day idempotency, exactly like the mood-reminder worker.
  await createAndWork<CycleReminderPayload>(
    boss,
    CYCLE_REMINDER_QUEUE,
    { localConcurrency: 1 },
    handleCycleReminderCheck,
  );
  // v1.17.1 — single-flight Vorsorge (measurement) reminder worker.
  // localConcurrency=1 keeps two ticks from racing the `nextDueAt`
  // advance that anchors the per-cycle idempotency, exactly like the
  // mood / cycle reminder workers.
  await createAndWork<MeasurementReminderPayload>(
    boss,
    MEASUREMENT_REMINDER_QUEUE,
    { localConcurrency: 1 },
    handleMeasurementReminderCheck,
  );
  // v1.18.1 — eventful Vorsorge satisfaction. Resolves a user's reminders
  // against their just-landed measurement / lab. Read-heavy on the user's
  // own data; the same small concurrency budget as PR detection.
  await createAndWork<ReminderSatisfyPayload>(
    boss,
    REMINDER_SATISFY_QUEUE,
    { localConcurrency: REMINDER_SATISFY_CONCURRENCY },
    handleReminderSatisfy,
  );

  return allQueues;
}
