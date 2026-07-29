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
 * A fan-out pass is judged on the pass, not on its legs. A nightly sweep
 * over every connected account is `ok: true` when the sweep ran, even if one
 * account's grant was revoked: that belongs on the account's own integration
 * ledger, and failing the queue would retry the whole cohort over one user's
 * expired token. The per-leg failures ride out as a count in `did`, which is
 * what makes them visible at all — today they are visible nowhere.
 *
 * `did` is the small pinned-shape bag of facts about the run — counts,
 * stable codes, booleans. It rides into the failure report and, once the
 * failure ledger lands, into the operator surface. Keep it to scalars that
 * a dashboard can key on; it is not a place for payload data or free text.
 */

/** A single fact about a run. Scalars only — never payload data. */
export type JobFact = string | number | boolean;

/** The pinned-shape bag of facts a handler reports about its run. */
export type JobFacts = Readonly<Record<string, JobFact>>;

/**
 * Facts cross a persistence/observability boundary. Keep their vocabulary
 * explicit so a caller cannot attach an identifier, credential, URL,
 * free-form error, or health value to a durable job result.
 */
export const JOB_FACT_ALLOWLIST: ReadonlySet<string> = new Set([
  "provider",
  "outcome",
  "total",
  "users_synced",
  "users_complete",
  "users_partial",
  "users_failed",
  "users_parked",
  "users_skipped",
  "users_useful",
  "users_clean_zero",
  "users_retryable",
  "downstream_failed",
  "measurements_imported",
  "deleted",
  "generated",
  "jobs",
  "skipped",
  "processed",
  "created",
  "updated",
  "failed",
  "retried",
  "queued",
  "sent",
  "subscription_repair_failed",
]);

export const MAX_JOB_FACTS = 32;
export const MAX_JOB_OUTCOME_BYTES = 2_048;

const STABLE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

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

export type SerializedJobOutcome =
  | { readonly ok: true; readonly did: JobFacts }
  | {
      readonly ok: false;
      readonly reason_code: string;
      readonly did?: JobFacts;
    };

function assertStableCode(value: string, label: string): void {
  if (!STABLE_CODE_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a stable lowercase code`);
  }
}

function validateFacts(facts: JobFacts): JobFacts {
  const entries = Object.entries(facts);

  if (entries.length > MAX_JOB_FACTS) {
    throw new RangeError(`job outcome exceeds ${MAX_JOB_FACTS} facts`);
  }

  for (const [key, value] of entries) {
    if (!JOB_FACT_ALLOWLIST.has(key)) {
      throw new TypeError(`job fact key is not allowed: ${key}`);
    }

    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(
          `job fact ${key} must be a non-negative safe integer`,
        );
      }
      continue;
    }

    if (typeof value === "string") {
      assertStableCode(value, `job fact ${key}`);
      continue;
    }

    if (typeof value !== "boolean") {
      throw new TypeError(`job fact ${key} must be a bounded scalar`);
    }
  }

  return Object.freeze(Object.fromEntries(entries)) as JobFacts;
}

/**
 * Produce the only representation suitable for persistence or structured
 * logging. The raw `cause` deliberately remains in-process for retry handling.
 */
export function serializeJobOutcome(outcome: JobOutcome): SerializedJobOutcome {
  const did = validateFacts(outcome.did ?? {});
  const serialized: SerializedJobOutcome = outcome.ok
    ? { ok: true, did }
    : (() => {
        assertStableCode(outcome.reason, "job failure reason");
        return outcome.did === undefined
          ? { ok: false, reason_code: outcome.reason }
          : { ok: false, reason_code: outcome.reason, did };
      })();

  const byteLength = new TextEncoder().encode(
    JSON.stringify(serialized),
  ).length;
  if (byteLength > MAX_JOB_OUTCOME_BYTES) {
    throw new RangeError(
      `serialized job outcome exceeds ${MAX_JOB_OUTCOME_BYTES} bytes`,
    );
  }

  return serialized;
}
