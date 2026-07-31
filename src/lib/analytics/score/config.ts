/**
 * v1.35.0 — per-user Health Score composition: the stored shape, the
 * schema that guards it, and the resolver every reader goes through.
 *
 * Three things this file is careful about, each because getting it
 * wrong is silent rather than loud.
 *
 * 1. **"Never chose" is not "chose nothing."** `excludedPillars` is
 *    `.optional()` and deliberately not `.default([])`. An absent key
 *    means the person never opened the surface, and such an account may
 *    still inherit a change of defaults later without its number
 *    jumping. A present list, even a long one, is an authored recipe
 *    and is never widened behind the person's back. Collapse the two
 *    and every never-configured account drifts the day defaults move.
 *
 * 2. **The stored list is a deselection list.** It records what the
 *    person took out, not what they left in. A pillar shipped after
 *    they chose is simply not in the list, so it counts, which is the
 *    "everything eligible" starting point applied to an existing
 *    account with no backfill. Had the column stored the positive
 *    selection, a newly shipped pillar would be indistinguishable from
 *    one the person deliberately removed, and the resolver would have
 *    to guess. This is the same posture as `modulePreferencesJson`.
 *
 * 3. **The catalogue wins on read.** Ids outside `SCORE_PILLAR_IDS` are
 *    dropped rather than trusted, so a retired pillar, a hand-edited
 *    blob, or a row written by a newer build can never put an unknown
 *    id in front of the scorer.
 *
 * The write route (`PATCH /api/auth/me/health-score-config`) speaks the
 * positive selection, because that is what a person sees and what the
 * score's published composition means. The inversion happens once, at
 * the boundary, in `healthScoreConfigFromSelection`.
 */
import { z } from "zod";

import {
  orderedUniquePillars,
  SCORE_PILLAR_IDS,
  type ScorePillarId,
} from "./types";

export const scorePillarIdSchema = z.enum(SCORE_PILLAR_IDS);

/**
 * The persisted blob.
 *
 * Deliberately not `.strict()`, and deliberately loose about the ids:
 * a row written by a newer build, or carrying a pillar this build has
 * retired, must degrade to what this build understands rather than
 * failing the parse. A failed parse reads as "never chose", which would
 * silently discard an authored recipe over one unrecognised string. The
 * ids are filtered against the catalogue on the way out instead. The
 * REQUEST body is the strict end: an unknown id there is a 422, because
 * a person's client has no business sending one.
 */
export const healthScoreConfigSchema = z.object({
  excludedPillars: z.array(z.string().max(64)).max(64).optional(),
  /** Per-user recipe version. Increments on every accepted write. */
  version: z.number().int().min(1).optional(),
  /** When the recipe last changed, ISO 8601. */
  changedAt: z.string().max(40).optional(),
});

export type HealthScoreConfig = z.infer<typeof healthScoreConfigSchema>;

/**
 * What an account that never chose gets: every pillar counts, no
 * recipe version, no change date. Read-time reconciliation is against
 * this, so a pillar added to `SCORE_PILLAR_IDS` later appears here and
 * in every resolved config without a backfill.
 */
export const DEFAULT_HEALTH_SCORE_CONFIG: Readonly<ResolvedHealthScoreConfig> =
  Object.freeze({
    pillars: Object.freeze([...SCORE_PILLAR_IDS]) as ScorePillarId[],
    excludedPillars: Object.freeze([] as ScorePillarId[]) as ScorePillarId[],
    hasSelection: false,
    version: 0,
    changedAt: null,
  });

/** A fresh, caller-owned copy of the defaults. */
function defaults(): ResolvedHealthScoreConfig {
  return {
    ...DEFAULT_HEALTH_SCORE_CONFIG,
    pillars: [...DEFAULT_HEALTH_SCORE_CONFIG.pillars],
    excludedPillars: [],
  };
}

export interface ResolvedHealthScoreConfig {
  /**
   * Registry-ordered pillars the person counts toward the score. This
   * is the composition the scorer starts from; data availability
   * narrows it further, and that narrowing is not a choice.
   */
  pillars: ScorePillarId[];
  /** Registry-ordered pillars the person took out. */
  excludedPillars: ScorePillarId[];
  /**
   * True once a selection has been written. It says the person chose,
   * not that their choice differs from the default: an account that
   * opened the surface and kept every pillar has a selection.
   */
  hasSelection: boolean;
  /** Per-user recipe version. 0 while no selection has been written. */
  version: number;
  /** When the recipe last changed. Null while no selection exists. */
  changedAt: string | null;
}

/**
 * Resolve a stored `healthScoreConfigJson` blob into the composition
 * the scorer and the settings surface both read.
 *
 * A null row, a non-object, or a shape that no longer parses all
 * resolve to the defaults, which is the honest fallback: the account
 * counts everything, exactly as it did before the column existed.
 */
export function resolveHealthScoreConfig(
  raw: unknown,
): ResolvedHealthScoreConfig {
  if (raw == null || typeof raw !== "object") return defaults();
  const parsed = healthScoreConfigSchema.safeParse(raw);
  if (!parsed.success) return defaults();
  if (parsed.data.excludedPillars === undefined) return defaults();

  const excludedPillars = orderedUniquePillars(parsed.data.excludedPillars);
  const excluded = new Set(excludedPillars);
  return {
    pillars: SCORE_PILLAR_IDS.filter((id) => !excluded.has(id)),
    excludedPillars,
    hasSelection: true,
    version: parsed.data.version ?? 1,
    changedAt: parsed.data.changedAt ?? null,
  };
}

/**
 * Turn the positive selection a person made into the blob the column
 * stores. Unknown ids are dropped on the way in, so the stored
 * deselection list only ever names pillars this build knows.
 *
 * `version` is supplied by the caller, which reads the previous version
 * off the row and increments it: the recipe version has to be monotonic
 * per account for a score record to say which recipe produced it.
 */
export function healthScoreConfigFromSelection(input: {
  selection: readonly ScorePillarId[];
  version: number;
  changedAt: Date;
}): HealthScoreConfig {
  const selected = new Set(orderedUniquePillars(input.selection));
  return {
    excludedPillars: SCORE_PILLAR_IDS.filter((id) => !selected.has(id)),
    version: input.version,
    changedAt: input.changedAt.toISOString(),
  };
}
