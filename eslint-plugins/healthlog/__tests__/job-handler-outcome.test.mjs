/**
 * Unit tests for the `healthlog/job-handler-outcome` rule — the bare
 * `boss.work(` ban, the one exempt module that owns `createAndWork`, the
 * test-file exemption, and the scope limit to `src/lib/jobs/`.
 *
 * The `invalid` cases below also stand as the rule's own documented blind
 * spots: an aliased or renamed receiver is not detected, and neither is a
 * handler that returns `{ ok: true }` after swallowing. Those sit in `valid`
 * on purpose, so a future reader can see what this rule does not claim.
 */
import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../job-handler-outcome.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: "module" },
});

ruleTester.run("job-handler-outcome", rule, {
  valid: [
    {
      code: "await createAndWork(boss, QUEUE, { localConcurrency: 1 }, handleX);",
      filename: "/repo/src/lib/jobs/reminder/register-status.ts",
    },
    {
      // The wrapper's own call — this module is the one legal caller.
      code: "await boss.work(queue, options, runJob(queue, handler));",
      filename: "/repo/src/lib/jobs/reminder/registrar-shared.ts",
    },
    {
      // Tests mock `boss.work` and assert against it directly.
      code: 'boss.work("q", {}, async () => {});',
      filename: "/repo/src/lib/jobs/__tests__/whoop-queues.test.ts",
    },
    {
      // Out of scope: not the worker tree.
      code: 'boss.work("q", {}, async () => {});',
      filename: "/repo/src/lib/integrations/status.ts",
    },
    {
      // Documented blind spot: an aliased receiver is not detected.
      code: 'const b = boss; b.work("q", {}, async () => {});',
      filename: "/repo/src/lib/jobs/reminder/register-rollup.ts",
    },
    {
      // Documented blind spot: this rule cannot see a swallowed failure.
      code: "await createAndWork(boss, QUEUE, {}, async () => ({ ok: true, did: {} }));",
      filename: "/repo/src/lib/jobs/reminder/register-rollup.ts",
    },
  ],
  invalid: [
    {
      code: 'await boss.work("scratch", async () => {});',
      filename: "/repo/src/lib/jobs/reminder/register-maintenance.ts",
      errors: [{ messageId: "bareBossWork" }],
    },
    {
      code: "await boss.work(QUEUE, { localConcurrency: 1 }, handleX);",
      filename: "/repo/src/lib/jobs/worker-status.ts",
      errors: [{ messageId: "bareBossWork" }],
    },
  ],
});
