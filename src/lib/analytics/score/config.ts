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
 *
 * ## What happens to an account that already exists
 *
 * Nothing, on the day it upgrades, and that is the whole promise. The
 * column starts null, the resolver reads null as version 0 with no
 * change date, and version 0 resolves to every pillar — which,
 * intersected with what the account's modules record, is exactly the
 * composition the module switches were producing before this release.
 * The number does not move, no series break is drawn, no notice is
 * raised, and no delta is suppressed. There is no backfill because
 * there is nothing to back-fill: the inheritance is the resolver's
 * behaviour, not a migration's.
 *
 * The first time someone opens the surface and saves, the version goes
 * 0 → 1 and a dated change appears beside it. From that instant three
 * things follow, all of them once:
 *
 *   * the week-over-week delta is suppressed for as long as the
 *     comparison window still straddles the change, with the reason
 *     `config_changed` — the person changed what counts, and a
 *     subtraction across that is not a health event;
 *   * the next stored day is marked as a series break, so the composite
 *     line is drawn in two segments rather than one line through the
 *     change (`./series.ts`), while the per-pillar rows run straight
 *     through it;
 *   * the notice key gains the recipe version, so the "you changed what
 *     counts" note is raised once and dismissed once per version, and a
 *     dismissal of one version never silences the next.
 *
 * What makes the previously invisible choice visible for the first time
 * is the surface itself, which is where the one-time note belongs and
 * where it is written. This file owns the behaviour that note describes;
 * saying it twice, in two places that can drift, is how a note ends up
 * describing something the code stopped doing.
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
const healthScoreConfigSchema = z.object({
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
 * Does this account's score run on an authored recipe?
 *
 * One boolean, resolved here so that no client ever reads a config blob
 * to answer it. The web hero, the iOS widget, the watch complication and
 * the public API all read the same value off the wire.
 *
 * **The definition, in one sentence:** the score is configured when the
 * composition it resolves to differs from the composition the account's
 * defaults would resolve to today. Both sides are narrowed by the same
 * modules, so the comparison is about the person's choice and nothing
 * else.
 *
 * Three consequences, each deliberate:
 *
 *   * An account that opened the surface and kept every pillar is NOT
 *     configured. It has a selection, and that selection is the default;
 *     nothing about its number is attributable to an authored recipe.
 *     This is why `hasSelection` is not this flag — that one answers
 *     "did the person write something", which is a different question
 *     and the wrong one to put in front of a widget.
 *   * An account whose modules alone narrow the set is NOT configured.
 *     The modules say what is being recorded, not what should count, and
 *     the defaults resolve through them identically.
 *   * An account that took out a pillar no module is feeding IS
 *     configured, because its resolved composition is genuinely
 *     narrower than the default one. Data availability narrows further
 *     still, and that narrowing is not a choice — so the comparison runs
 *     before it, and the flag does not flicker as readings arrive.
 *
 * The mirror of the third: taking out a pillar whose module is already
 * off changes nothing, and the flag says so. The recipe is stored and
 * comes back the moment the module returns; today it makes no difference
 * to the number, and claiming otherwise would be a surface claiming more
 * than it does.
 *
 * `recordedPillars` is what `pillarsWithModuleData(modules)` returns.
 * Required, and deliberately not defaulted: a caller that left it out
 * would compare against every pillar in the catalogue and report a
 * module-narrowed account as configured, which is precisely the answer
 * this flag exists to avoid.
 */
export function resolveScoreConfigured(args: {
  config: Pick<ResolvedHealthScoreConfig, "pillars">;
  recordedPillars: readonly ScorePillarId[];
}): boolean {
  const recorded = new Set(args.recordedPillars);
  const resolved = args.config.pillars.filter((id) => recorded.has(id));
  const byDefault = DEFAULT_HEALTH_SCORE_CONFIG.pillars.filter((id) =>
    recorded.has(id),
  );
  return (
    resolved.length !== byDefault.length ||
    resolved.some((id, index) => id !== byDefault[index])
  );
}

/**
 * The recipe's identity, reduced to the two things a comparison needs:
 * which version of the person's own recipe produced a number, and when
 * that recipe last moved.
 *
 * Carried separately from the full resolved config because the delta
 * guard and the stored record have no business seeing the pillar list —
 * they compare recipes, they do not apply them.
 */
export interface ScoreConfigBoundary {
  /** Per-user recipe version. 0 while the person never chose. */
  version: number;
  /** When the recipe last changed, ISO 8601, or null while it never has. */
  changedAt: string | null;
}

/**
 * The boundary of an account that never authored a recipe.
 *
 * Exported so a caller that genuinely has no configuration says so by
 * name instead of leaving an argument out. A guard parameter with a
 * plausible default is how a caller stays silent and the guard stays
 * quiet about it.
 */
export const UNCONFIGURED_SCORE_BOUNDARY: Readonly<ScoreConfigBoundary> =
  Object.freeze({ version: 0, changedAt: null });

/** Narrow a resolved config to the identity a comparison reads. */
export function scoreConfigBoundary(
  config: Pick<ResolvedHealthScoreConfig, "version" | "changedAt">,
): ScoreConfigBoundary {
  return { version: config.version, changedAt: config.changedAt };
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
