/**
 * v1.35.0 — which modules put data in front of which score pillar.
 *
 * Until this release the mapping existed only as ternaries inside the
 * reader's `availablePillars` expression, where nothing could read it
 * and nothing could test it. It is named here because two questions
 * that used to have one answer now have two, and confusing them is how
 * a person's number moves without them asking for it:
 *
 *   - the CONFIG says which pillars a person counts toward their score;
 *   - a MODULE says whether that pillar's data is being recorded at all.
 *
 * The score takes the intersection. A module that is off cannot be
 * overridden by a selection, because turning the module off closes the
 * data path itself; and a pillar left out of the config stays out
 * however much data flows into it.
 *
 * `GLYCAEMIA` appears under two modules on purpose: it scores off
 * fasting glucose OR HbA1c, so either module alone keeps it fed. That
 * was the `glucose || labs` ternary, and it is the entry that would be
 * lost by assuming one module per pillar.
 *
 * `BLOOD_PRESSURE`, `ACTIVITY` and `ADIPOSITY` are absent from the map,
 * which is the same thing the reader has always done: they read core
 * measurement domains that carry no module switch, so no module can
 * withdraw their data. Absent means ungated, not forgotten — the test
 * beside this file pins the three so a silent addition to the map cannot
 * quietly start gating one of them.
 */
import { SCORE_PILLAR_IDS, type ScorePillarId } from "./types";

/**
 * The modules the score reader is handed. Every key here gates at least
 * one pillar; a module that gates nothing has no reason to be passed.
 */
export interface ScoreReaderModules {
  glucose: boolean;
  labs: boolean;
  sleep: boolean;
  mentalHealth: boolean;
}

export type ScoreModuleKey = keyof ScoreReaderModules;

/** Which pillars each module feeds. Registry ids, checked by the tests. */
export const MODULE_SCORE_PILLARS: Record<
  ScoreModuleKey,
  readonly ScorePillarId[]
> = {
  glucose: ["GLYCAEMIA"],
  labs: ["GLYCAEMIA", "LIPIDS"],
  sleep: ["SLEEP"],
  mentalHealth: ["WELLBEING"],
};

const MODULE_KEYS = Object.keys(MODULE_SCORE_PILLARS) as ScoreModuleKey[];

/** Pillars whose data any module can withdraw. Derived, never restated. */
export const MODULE_GATED_PILLARS: ReadonlySet<ScorePillarId> = new Set(
  MODULE_KEYS.flatMap((key) => MODULE_SCORE_PILLARS[key]),
);

/**
 * The registry-ordered pillars whose data is actually being recorded,
 * given the account's modules. This is availability, not choice: it says
 * nothing about what the person wants counted, only about what there
 * could be data for.
 */
export function pillarsWithModuleData(
  modules: ScoreReaderModules,
): ScorePillarId[] {
  const fed = new Set<ScorePillarId>();
  for (const key of MODULE_KEYS) {
    if (!modules[key]) continue;
    for (const id of MODULE_SCORE_PILLARS[key]) fed.add(id);
  }
  return SCORE_PILLAR_IDS.filter(
    (id) => !MODULE_GATED_PILLARS.has(id) || fed.has(id),
  );
}
