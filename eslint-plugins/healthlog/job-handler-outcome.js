/**
 * @fileoverview ESLint rule — a pg-boss queue binding must go through
 * `createAndWork`, never a bare `boss.work(`.
 *
 * `boss.work(queue, options, handler)` completes a job whenever the handler's
 * promise resolves, whatever it resolves to. Every binding in this tree used
 * to be written that way, so a handler that caught an error, logged a warning
 * and returned looked exactly like one that did its work. `createAndWork`
 * (`src/lib/jobs/reminder/registrar-shared.ts`) types its handler as
 * `(jobs) => Promise<JobOutcome>` and wraps it in `runJob`, which fails the
 * pg-boss job on `ok: false`. Routing every binding through it is what makes
 * "the handler returned nothing" a compile error rather than a silent pass.
 *
 * WHAT THIS RULE PROVES, AND WHAT IT DOES NOT
 *
 * It proves that no queue in this tree is bound by a path that accepts a
 * void handler. That is all it proves. It does NOT detect a handler that
 * returns `{ ok: true }` after swallowing an exception — that compiles, it
 * passes this rule, and it is exactly as invisible as the defect the outcome
 * type was written for. The rule converts an omission (forgetting to signal
 * failure) into a commission (claiming a success that did not happen). The
 * second is a smaller class and a reviewable one; it is not zero.
 *
 * Two further evasions are known and unhandled: aliasing the method
 * (`const w = boss.work.bind(boss)`, `const { work } = boss`) and calling
 * `work` on an object not named `boss`. Both are syntactic dodges a reviewer
 * would see in the diff; neither is defended against here.
 *
 * Scope: `src/lib/jobs/`, excluding the registrar module that owns the one
 * legal `boss.work` call and excluding test files, which mock `boss.work`
 * and assert against it directly.
 *
 * @see src/lib/jobs/run-job.ts
 * @see src/lib/jobs/job-outcome.ts
 * @see src/lib/jobs/reminder/registrar-shared.ts
 */

"use strict";

// The one module allowed to call `boss.work` — `createAndWork` lives here
// and is the wrapper every other binding has to use.
const EXEMPT_FILES = ["src/lib/jobs/reminder/registrar-shared.ts"];

// The worker tree. A `boss.work` outside it would not be a queue binding.
const ENFORCED_ROOTS = ["src/lib/jobs/"];

function toPosix(filename) {
  return filename.replace(/\\/g, "/");
}

function isTestFile(posix) {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(posix) ||
    /\.spec\.[cm]?[jt]sx?$/.test(posix) ||
    posix.includes("/__tests__/") ||
    posix.includes("/__mocks__/")
  );
}

function isEnforced(filename) {
  const posix = toPosix(filename);
  if (!ENFORCED_ROOTS.some((root) => posix.includes(root))) return false;
  if (EXEMPT_FILES.some((f) => posix.includes(f))) return false;
  if (isTestFile(posix)) return false;
  return true;
}

/** @type {import("eslint").Rule.RuleModule} */
const jobHandlerOutcomeRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "pg-boss queue bindings must go through createAndWork so the handler returns a JobOutcome.",
    },
    schema: [],
    messages: {
      bareBossWork:
        'boss.work() completes a job whenever the handler resolves, so a swallowed failure reads as success. Bind the queue with createAndWork(boss, QUEUE, options, handler) from "./registrar-shared" — its handler type is (jobs) => Promise<JobOutcome> and runJob fails the job on ok:false.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (!filename || !isEnforced(filename)) {
      return {};
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "work" ||
          callee.object.type !== "Identifier" ||
          callee.object.name !== "boss"
        ) {
          return;
        }
        context.report({ node, messageId: "bareBossWork" });
      },
    };
  },
};

module.exports = jobHandlerOutcomeRule;
