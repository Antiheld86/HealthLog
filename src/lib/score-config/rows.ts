/**
 * v1.35.0 — what the "what counts toward your score" surface shows, as a
 * pure function over three inputs the page already holds.
 *
 * Kept out of the component so the row states can be driven directly by a
 * test instead of through a rendered tree, and so the page has exactly one
 * place that decides what a row says.
 *
 * The three inputs, and why each is needed:
 *
 *   - **the draft selection** — what the person currently has switched on
 *     in front of them, which is not yet what the server holds;
 *   - **the modules map** — whether the pillar's data is being recorded at
 *     all. A pillar every feeding module has switched off is not shown,
 *     full stop (see `omitted`, and `composition-source.test.ts`, which
 *     pins the same decision one layer down);
 *   - **the server's own pillar verdicts** — whether a pillar currently
 *     scores, is waiting for data, is suppressed for safety, or could not
 *     be read. These are never re-derived here. A pillar the server said
 *     nothing about reads as `unknown`, and `unknown` renders no claim.
 *
 * The eligibility a row shows describes the recipe the SERVER scored, not
 * the draft in front of the person. That is deliberate: the draft has not
 * been computed against anything, so a line derived from it would be a
 * guess wearing the voice of a fact.
 */
import {
  SCORE_PILLAR_DOMAINS,
  SCORE_PILLAR_IDS,
  type ScoreDomain,
  type ScorePillarId,
} from "@/lib/analytics/score/types";
import {
  pillarsWithModuleData,
  type ScoreModuleKey,
  type ScoreReaderModules,
} from "@/lib/analytics/score/modules";

/**
 * What the server's last scoring run said about one pillar. Every value
 * comes from a `ScorePillarResult`; nothing here is computed from data.
 */
export type ScoreRowEligibility =
  /** It scored. */
  | "counting"
  /** Selected, its data path is open, and there is nothing to score yet. */
  | "waiting"
  /** Wellbeing under crisis signposting. Never a configuration problem. */
  | "crisis"
  /** The read broke. Absence and failure are different states. */
  | "read_failed"
  /** The server said nothing about it. No claim is made either way. */
  | "unknown";

export interface ScoreConfigRow {
  id: ScorePillarId;
  domain: ScoreDomain;
  /** True when the draft counts this pillar toward the score. */
  counts: boolean;
  eligibility: ScoreRowEligibility;
}

export interface ScoreConfigGroup {
  domain: ScoreDomain;
  rows: ScoreConfigRow[];
}

/**
 * One pillar's verdict as the page reads it off the report: the status,
 * plus the reason when the status is `insufficient`.
 */
export interface ScorePillarVerdict {
  status: "ok" | "insufficient";
  reason?: string | null;
}

export interface BuildScoreConfigRowsInput {
  /** The draft selection the switches currently show. */
  selection: readonly ScorePillarId[];
  /** Resolved module map. A missing key reads as ON (fail open). */
  modules: Partial<Record<ScoreModuleKey, boolean>>;
  /**
   * Per-pillar verdicts from the last scoring run, keyed by pillar id.
   * A pillar the server did not report on is simply absent.
   */
  verdicts?: Partial<Record<ScorePillarId, ScorePillarVerdict>>;
}

/** Fail-open module resolution, matching every other gate in the app. */
function resolveModules(
  modules: Partial<Record<ScoreModuleKey, boolean>>,
): ScoreReaderModules {
  return {
    glucose: modules.glucose !== false,
    labs: modules.labs !== false,
    sleep: modules.sleep !== false,
    mentalHealth: modules.mentalHealth !== false,
  };
}

function eligibilityOf(
  verdict: ScorePillarVerdict | undefined,
): ScoreRowEligibility {
  if (!verdict) return "unknown";
  if (verdict.status === "ok") return "counting";
  if (verdict.reason === "crisis_signposting") return "crisis";
  if (verdict.reason === "read_failed") return "read_failed";
  return "waiting";
}

/**
 * The pillars whose data path is closed, so the surface omits them.
 *
 * Returned beside the groups rather than silently dropped, because a
 * caller that wants to say where those pillars went (the modules screen)
 * needs to know there were any.
 */
export interface ScoreConfigRowsResult {
  groups: ScoreConfigGroup[];
  /** Registry-ordered pillars hidden because every feeding module is off. */
  omitted: ScorePillarId[];
}

/**
 * Build the surface's rows, grouped by domain in registry order.
 *
 * A domain with no visible rows produces no group, so a heading can never
 * stand above an empty cluster.
 */
export function buildScoreConfigRows(
  input: BuildScoreConfigRowsInput,
): ScoreConfigRowsResult {
  const recorded = new Set(
    pillarsWithModuleData(resolveModules(input.modules)),
  );
  const selected = new Set(input.selection);
  const groups: ScoreConfigGroup[] = [];
  const byDomain = new Map<ScoreDomain, ScoreConfigRow[]>();
  const omitted: ScorePillarId[] = [];

  for (const id of SCORE_PILLAR_IDS) {
    if (!recorded.has(id)) {
      omitted.push(id);
      continue;
    }
    const domain = SCORE_PILLAR_DOMAINS[id];
    const row: ScoreConfigRow = {
      id,
      domain,
      counts: selected.has(id),
      eligibility: eligibilityOf(input.verdicts?.[id]),
    };
    const existing = byDomain.get(domain);
    if (existing) {
      existing.push(row);
    } else {
      const rows = [row];
      byDomain.set(domain, rows);
      groups.push({ domain, rows });
    }
  }

  return { groups, omitted };
}

/**
 * Whether a row earns the "selected, waiting for data" line.
 *
 * Narrow on purpose, and the narrowing is the decision: the line belongs
 * to a pillar the person counts, whose module is on (which is what makes
 * the row visible at all), and which the server reported as having
 * nothing to score yet. A pillar whose module is off never reaches here
 * because it has no row; a pillar the draft excludes is not waiting for
 * anything on the person's behalf; and an `unknown` verdict is not
 * evidence of absence.
 */
export function showsWaitingForData(row: ScoreConfigRow): boolean {
  return row.counts && row.eligibility === "waiting";
}
