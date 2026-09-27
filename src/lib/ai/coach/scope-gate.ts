/**
 * The one exclusion gate every Coach read passes: the snapshot builder's
 * source narrowing, a table tool's gate, and a stored table shown again.
 * Kept apart from the snapshot builder so the gate can be used (and tests
 * can stand the builder in) without loading it.
 */
import type { ModuleKey } from "@/lib/modules/registry";
import { MODULE_SCOPED_SOURCES } from "@/lib/modules/measurement-scope";
import type { CoachScopeSource } from "@/lib/ai/coach/types";
import type {
  CoachExcludeMetric,
  CoachPrefs,
} from "@/lib/validations/coach-prefs";

/**
 * v1.18.0 — module enable/disable → coach-snapshot domain map.
 *
 * When a toggleable data-domain module is disabled for the account, the
 * domains it owns must never enter the coach context. We reuse the
 * existing `excludeMetrics` filtering path (the `excluded` set narrows
 * `sources` before any row is read) by folding the disabled modules into
 * a SYSTEM-side exclusion that unions with the user's `excludeMetrics`.
 *
 * Each toggleable data domain maps to the `CoachScopeSource` token(s)
 * its snapshot block(s) gate on:
 *   - `mood`      → the mood block (`mood` source).
 *   - `sleep`     → the per-night sleep block + the sleep-rhythm block
 *                   (both gate on the `sleep` source).
 *   - `glucose`   → the glucose per-context + clinical block.
 *   - `workouts`  → the workouts block.
 *   - `recovery`  → the recovery / strain composites. These are the
 *                   derived block (READINESS / RECOVERY_SCORE / STRAIN_SCORE
 *                   / …), the WHOOP-native dayStrain block, and the
 *                   trajectory block — all gated on `derivedActive`, which
 *                   reads HRV / resting-HR / VO₂max. Dropping those source
 *                   tokens drops the raw additive timelines too; the
 *                   composites are additionally gated below so they never
 *                   build off the sleep signal alone.
 *   - `environment` → the audio-exposure (env / headphone / event), daylight,
 *                   and skin-temperature blocks — the sources the opt-in
 *                   environment cluster owns (`CLUSTER_SOURCES.environment`).
 *
 * `cycle` is intentionally absent: its block already resolves through the
 * fully two-layer cycle gate (`isCycleAvailableForUser` — the per-user
 * toggle AND the operator server-wide kill-switch) below, exactly as the
 * W1 foundation prescribes. `coach` is the surface being narrated, not
 * a data domain. `labs` / `achievements` / `insights` / `doctorReport`
 * own no coach-snapshot data domain.
 *
 * v1.30.22 — the table itself moved to `@/lib/modules/measurement-scope` so
 * the reads that deliberately bypass this builder (the MCP rich reads) gate
 * off the SAME ownership map instead of inheriting nothing. The narrowing
 * below is unchanged; only the definition site moved.
 */
const MODULE_EXCLUDED_SOURCES = MODULE_SCOPED_SOURCES as Partial<
  Record<ModuleKey, CoachScopeSource[]>
>;

/**
 * What the Coach may not read for this person: their own `excludeMetrics`
 * plus every source a switched-off module owns (`moduleMap[key] === false`;
 * the gate has already resolved every delegation, so the map is
 * authoritative).
 */
export function coachExclusions(
  prefs: Pick<CoachPrefs, "excludeMetrics">,
  moduleMap: Readonly<Record<ModuleKey, boolean>>,
): ReadonlySet<CoachExcludeMetric> {
  const excluded = new Set<CoachExcludeMetric>(prefs.excludeMetrics);
  for (const [key, srcs] of Object.entries(MODULE_EXCLUDED_SOURCES)) {
    if (moduleMap[key as ModuleKey] === false) {
      for (const src of srcs ?? []) {
        // Every entry in MODULE_EXCLUDED_SOURCES is a CoachScopeSource that
        // also exists in the CoachExcludeMetric enum overlap the
        // source-narrowing check reads.
        excluded.add(src as unknown as CoachExcludeMetric);
      }
    }
  }
  return excluded;
}

/**
 * The sources of a scope the Coach may read: the scope minus the
 * exclusions, and no medication compliance when medications are excluded
 * (excluding medications means no medication data at all). The one gate
 * every read passes, the snapshot's own and the table tools' alike.
 */
export function admitCoachSources(
  scoped: Iterable<CoachScopeSource>,
  excluded: ReadonlySet<CoachExcludeMetric>,
): Set<CoachScopeSource> {
  const sources = new Set<CoachScopeSource>();
  for (const src of scoped) {
    // The `excludeMetrics` enum is a superset of `CoachScopeSource`
    // (medications + anthropometrics live on the exclude-only side); the
    // runtime `has` check only catches the overlapping members.
    if (!excluded.has(src as unknown as CoachExcludeMetric)) sources.add(src);
  }
  if (excluded.has("medications")) sources.delete("compliance");
  return sources;
}
