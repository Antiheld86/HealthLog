/**
 * The value a background-job handler returns to say what it did.
 *
 * Before this type existed, a pg-boss handler signalled success by falling
 * off the end of a function. Every one of the queue bindings in this tree
 * resolved to `undefined`, and none of them was read anywhere, so a handler
 * that caught an error, logged a warning and returned was indistinguishable
 * from one that finished its work. pg-boss marked both `completed`; the
 * operator surfaces that read `pgboss.job` saw nothing; the nightly pass
 * looked healthy for as long as it kept failing.
 *
 * A returned `JobOutcome` closes that specific gap: completion is now
 * derived from a value the handler had to construct, and `runJob` turns
 * `ok: false` into a failed pg-boss job. What the type CANNOT do is make a
 * handler honest — `jobDone()` after swallowing an exception compiles and
 * passes every check in this repository. It converts omission (forgetting to
 * signal a failure) into commission (claiming a success that did not
 * happen), which is a smaller and much more reviewable class of defect.
 *
 * `did` is the small pinned-shape bag of facts about the run — counts,
 * identifiers, booleans. It rides into the failure report and, once the
 * failure ledger lands, into the operator surface. Keep it to scalars that
 * a dashboard can key on; it is not a place for payload data or free text.
 */

/** A single fact about a run. Scalars only — never payload data. */
export type JobFact = string | number | boolean;

/** The pinned-shape bag of facts a handler reports about its run. */
export type JobFacts = Readonly<Record<string, JobFact>>;

/**
 * What a handler did. `ok: true` means the work named by the queue actually
 * happened; `ok: false` means it did not, and `runJob` will fail the pg-boss
 * job so the failure reaches the retry policy and the operator surfaces.
 *
 * A run that legitimately had nothing to do is `ok: true` with a zero count
 * in `did` — absence of work is not failure. A run that could not do its
 * work (provider down, query timed out, key missing) is `ok: false` even
 * when the handler previously chose to carry on.
 */
export type JobOutcome =
  | {
      readonly ok: true;
      readonly did: JobFacts;
    }
  | {
      readonly ok: false;
      /** Short, stable, greppable. `"nightscout fetch failed"`, not a stack. */
      readonly reason: string;
      /** The thrown value, when there was one. Preserved for the stack. */
      readonly cause?: unknown;
      /** Whatever the run managed before it failed. */
      readonly did?: JobFacts;
    };

/** The run did its work. Pass the counts that make the run auditable. */
export function jobDone(did: JobFacts = {}): JobOutcome {
  return { ok: true, did };
}

/**
 * The run did not do its work. `runJob` reports this and rethrows, so the
 * pg-boss job fails and the queue's retry policy applies — check that policy
 * when converting a handler that used to swallow, because a deterministic
 * failure now retries instead of passing quietly.
 */
export function jobFailed(
  reason: string,
  cause?: unknown,
  did?: JobFacts,
): JobOutcome {
  return { ok: false, reason, cause, did };
}
