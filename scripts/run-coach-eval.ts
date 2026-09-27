#!/usr/bin/env tsx
/**
 * Coach evaluation runner (B0, v1.21.3).
 *
 * Two layers:
 *   1. The DETERMINISTIC suite always runs (free, offline) — it grades every
 *      golden case's reference response through the deterministic graders and
 *      runs the red-team battery via Vitest. That is the per-PR gate and is
 *      driven by `pnpm test`, not this script; here we print a deterministic
 *      summary for the nightly log.
 *   2. The LIVE JUDGE runs ONLY when `COACH_EVAL_API_KEY` is present. With the
 *      secret absent it no-ops with a clear line and exits 0 — the nightly
 *      workflow stays green and non-blocking. The same key runs the dialog
 *      scenarios live: each is put to the model a few times and the tool
 *      calls (with their arguments) are graded, reported as a pass rate per
 *      scenario.
 *
 * Usage (nightly workflow / manual):
 *   COACH_EVAL_API_KEY=... pnpm dlx tsx scripts/run-coach-eval.ts
 *   pnpm dlx tsx scripts/run-coach-eval.ts        # no secret → judge skips
 */
import {
  GOLDEN_CASES,
  taxonomyCoverage,
} from "@/lib/ai/coach/eval/golden-cases";
import { captureDeterministic } from "@/lib/ai/coach/eval/run-case";
import { gradeSet } from "@/lib/ai/coach/eval/grade-groundedness";
import { runJudge, runScenarioJudge } from "@/lib/ai/coach/eval/judge";

async function main() {
  // Deterministic summary (the gate itself is the Vitest suite).
  const captures = GOLDEN_CASES.map(captureDeterministic);
  const det = gradeSet(GOLDEN_CASES, captures);
  console.log(
    `Deterministic floor: ${det.passed}/${det.total} cases pass.`,
    `Taxonomy: ${JSON.stringify(taxonomyCoverage())}`,
  );
  if (det.failed > 0) {
    console.error(
      `Deterministic floor has ${det.failed} failing case(s) — see the Vitest gate.`,
    );
    process.exitCode = 1;
    return;
  }

  // Live judge — gated on the secret, never blocking.
  const judged = await runJudge();
  if (!judged.ran) {
    console.log(judged.note);
    return;
  }
  console.log(judged.note);
  console.log(
    `Live judge: ${judged.passed}/${judged.cases.length} cases pass.`,
  );
  for (const c of judged.cases) {
    if (!c.passed) {
      console.log(
        `  FAIL ${c.id} [${c.taxonomy}] warmth=${c.warmth} safety=${c.safety} ${c.earned}/${c.total}`,
      );
    }
  }
  await reportScenarios();
}

/** The dialog scenarios, live: a pass rate per scenario, misses listed. */
async function reportScenarios() {
  const run = await runScenarioJudge();
  console.log(run.note);
  for (const scenario of run.scenarios) {
    console.log(
      `  ${scenario.passRate === 1 ? "PASS" : "MISS"} ${scenario.id} ${scenario.passed}/${scenario.runs}`,
    );
    scenario.misses.forEach((missed, i) => {
      console.log(`    run ${i + 1}: ${missed.join("; ")}`);
    });
    scenario.toolCalls.forEach((calls, i) => {
      console.log(
        `    calls ${i + 1}: ${calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(", ") || "none"}`,
      );
    });
  }
}

main().catch((err) => {
  // Never let the nightly run hard-crash — the live judge is non-blocking.
  console.error("Coach eval runner error (non-blocking):", err);
});
