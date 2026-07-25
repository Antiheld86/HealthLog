/**
 * Dead-policy guard, in the same spirit as the v1.4.37 dead-queue guards.
 *
 * A queue's `singletonKey` only de-duplicates if its registrar names a policy
 * for it: pg-boss constrains `singleton_key` through partial unique indexes
 * scoped by queue policy, and the default `standard` policy has none. So the
 * enqueue site and the registrar entry are two halves of one guarantee that
 * live in different files, and nothing in the type system couples them —
 * deleting the registrar entry leaves the `singletonKey` at the call site
 * looking entirely correct while it silently stops doing anything.
 *
 * These assertions are that coupling. Each queue below is listed with the
 * policy its call site depends on; dropping or weakening an entry turns this
 * suite red instead of quietly restoring the storm.
 *
 * The behavioural proof that the policies mean what the names say lives in
 * `tests/integration/queue-singleton-policy.integration.test.ts`, which runs a
 * real pg-boss against a real Postgres.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (file: string) =>
  fs.readFileSync(path.resolve(__dirname, "../reminder", file), "utf8");

/**
 * Assert that `queue` appears in the registrar's `queuePolicies` table with
 * `policy`. Anchored to the table so an unrelated mention of the constant
 * elsewhere in the file cannot satisfy it.
 */
function expectPolicy(source: string, queue: string, policy: string) {
  const table = source.match(
    /const queuePolicies: QueuePolicyTable = \{([\s\S]*?)\n\};/,
  );
  expect(table, "registrar has no queuePolicies table").not.toBeNull();
  const entry = new RegExp(`\\[${queue}\\]:\\s*\\{\\s*policy:\\s*"${policy}"`);
  expect(
    table![1],
    `${queue} must carry the "${policy}" policy — without it the singletonKey at its enqueue site is inert`,
  ).toMatch(entry);
}

describe("rollup registrar queue policies", () => {
  const source = read("register-rollup.ts");

  // `short`, not `exclusive`: the handler re-reads the bucket when it starts,
  // so only QUEUED duplicates may be collapsed. Promoting either of these to
  // `exclusive` would strand a measurement written while a recompute ran.
  it.each([
    ["ROLLUP_RECOMPUTE_QUEUE", "short"],
    ["MOOD_ROLLUP_RECOMPUTE_QUEUE", "short"],
  ])("%s is %s", (queue, policy) => {
    expectPolicy(source, queue, policy);
  });

  // Per-user, self-converging backfills: a second concurrent run is pure
  // duplicated work and discovery re-offers the job while it is outstanding.
  it.each([
    ["ROLLUP_FULL_BACKFILL_QUEUE", "exclusive"],
    ["MOOD_ROLLUP_FULL_BACKFILL_QUEUE", "exclusive"],
    ["MEDICATION_COMPLIANCE_BACKFILL_QUEUE", "exclusive"],
    ["STEP_CONSOLIDATION_QUEUE", "exclusive"],
    ["STEP_CONSOLIDATION_REPAIR_QUEUE", "exclusive"],
    ["CUMULATIVE_PR_REDERIVE_QUEUE", "exclusive"],
    ["MEAN_CONSOLIDATION_QUEUE", "exclusive"],
    ["DENSE_INTRADAY_RETENTION_QUEUE", "exclusive"],
    ["DENSE_INTRADAY_HOURLY_REBUILD_QUEUE", "exclusive"],
  ])("%s is %s", (queue, policy) => {
    expectPolicy(source, queue, policy);
  });
});

describe("status registrar queue policies", () => {
  const source = read("register-status.ts");

  it("MORNING_DIGEST_REFRESH_QUEUE is exclusive", () => {
    // Seven sleep-write seams enqueue the same user+localDate key. Without
    // this the at-most-once-per-morning contract does not hold and the failure
    // path re-triggers forced comprehensive generations against the provider.
    expectPolicy(source, "MORNING_DIGEST_REFRESH_QUEUE", "exclusive");
  });
});

describe("integration-sync registrar queue policies", () => {
  const source = read("register-integration-sync.ts");

  it.each([
    ["WHOOP_BACKFILL_QUEUE", "exclusive"],
    ["FITBIT_BACKFILL_QUEUE", "exclusive"],
    ["GOOGLE_HEALTH_BACKFILL_QUEUE", "exclusive"],
    ["STRAVA_BACKFILL_QUEUE", "exclusive"],
    ["GOOGLE_HEALTH_SLEEP_REPAIR_QUEUE", "exclusive"],
    ["FITBIT_SLEEP_REPAIR_QUEUE", "exclusive"],
    ["SLEEP_TIMELINE_BACKFILL_QUEUE", "exclusive"],
    ["LAB_BIOMARKER_BACKFILL_QUEUE", "exclusive"],
  ])("%s is %s", (queue, policy) => {
    expectPolicy(source, queue, policy);
  });
});

describe("maintenance registrar queue policies", () => {
  const source = read("register-maintenance.ts");

  it.each([
    ["INTAKE_SLOT_DEDUP_QUEUE", "exclusive"],
    ["NOTE_ENCRYPTION_BACKFILL_QUEUE", "exclusive"],
    ["MED_NOTES_ENCRYPTION_BACKFILL_QUEUE", "exclusive"],
    ["DOCUMENT_THUMBNAIL_BACKFILL_QUEUE", "exclusive"],
    ["CONTENT_INDEX_BACKFILL_QUEUE", "exclusive"],
    ["ENCRYPTION_KEY_ROTATE_QUEUE", "exclusive"],
  ])("%s is %s", (queue, policy) => {
    expectPolicy(source, queue, policy);
  });

  // Per-document queues have no discovery pass to re-converge, so a re-process
  // requested after the running job read the old bytes must be admitted.
  it.each([
    ["DOCUMENT_INDEX_QUEUE", "short"],
    ["DOCUMENT_THUMBNAIL_QUEUE", "short"],
    ["DOCUMENT_SUMMARY_QUEUE", "short"],
  ])("%s is %s", (queue, policy) => {
    expectPolicy(source, queue, policy);
  });

  it("ENVIRONMENT_FETCH_QUEUE is deliberately left on standard", () => {
    // Its explicit-range backfill sends with no key at all, on purpose, so any
    // policy would collapse two different requested date ranges onto the shared
    // empty key. This asserts the omission is intentional and documented, so a
    // future reader does not "complete" the table and silently merge them.
    const table = source.match(
      /const queuePolicies: QueuePolicyTable = \{([\s\S]*?)\n\};/,
    );
    expect(table![1]).not.toMatch(/\[ENVIRONMENT_FETCH_QUEUE\]/);
    expect(source).toMatch(/ENVIRONMENT_FETCH_QUEUE is LEFT ALONE/);
  });
});

describe("every policy decision carries a reason", () => {
  it.each([
    "register-rollup.ts",
    "register-status.ts",
    "register-integration-sync.ts",
    "register-maintenance.ts",
  ])("%s", (file) => {
    const table = read(file).match(
      /const queuePolicies: QueuePolicyTable = \{([\s\S]*?)\n\};/,
    );
    expect(table).not.toBeNull();

    const policies = table![1].match(/policy:\s*"(?:short|exclusive)"/g) ?? [];
    const reasons = table![1].match(/reason:\s*\n?\s*"/g) ?? [];
    expect(policies.length).toBeGreaterThan(0);
    // A policy without a stated reason is the thing this whole change exists
    // to prevent: the next person re-deriving intent from the call sites.
    expect(reasons.length).toBe(policies.length);
  });
});
