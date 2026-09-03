/**
 * Queue name and pg-boss send policy for the weekly on-host data backup.
 *
 * A leaf module on purpose: the cron registrar, the admin "run now" route and
 * the policy test all need these two facts, and none of them should have to
 * pull in the worker's handler graph to get them.
 *
 * The queue was registered with no send options, so every job it minted took
 * pg-boss 12.26's queue defaults — `expireInSeconds: 900`, `retryLimit: 2`
 * (`QUEUE_DEFAULTS` in `pg-boss/dist/plans.js`). Fifteen minutes is a fine
 * default for a cleanup tick and far too short for a pass that serialises every
 * account's whole record: the job was killed mid-run, redelivered twice against
 * the same record, and reached `failed` with `job timed out` about 46 minutes
 * after it started. Nothing about that says "too slow" — the pass never got to
 * finish once.
 *
 * Two hours is deliberately generous rather than tuned. The handler now costs a
 * fraction of that on a large record (see the CHANGELOG entry), but the pass
 * loops over EVERY account on the instance and a self-host's disk is whatever
 * it is; the window's job is to be impossible to hit for the right reasons, and
 * a failure that arrives at the two-hour mark is a real one worth reading.
 * pg-boss refuses anything at or past 24 hours.
 *
 * The default `retryLimit: 2` stays. The old redeliveries were pointless
 * because the first attempt could not succeed either; a transient failure — a
 * pool hiccup, a locked row — genuinely benefits from a second attempt, and the
 * alternative is losing the week.
 *
 * The options ride on the SEND, not on `createQueue`: pg-boss's `create_queue()`
 * ends in `ON CONFLICT DO NOTHING`, so a queue-level default would apply to a
 * fresh database and be inert on every instance that already has the queue —
 * exactly the trap `reconcileQueuePolicies` exists to work around.
 */

export const DATA_BACKUP_QUEUE = "data-backup";

export const DATA_BACKUP_SEND_OPTIONS = {
  expireInSeconds: 2 * 60 * 60,
} as const;
