import { describe, expect, it } from "vitest";

import { DEFAULT_HEALTH_SCORE_CONFIG, resolveScoreConfigured } from "../config";
import type { ScorePillarId } from "../types";

/**
 * The "this score is configured" flag, at the level where its definition
 * lives.
 *
 * The flag was proven end to end over the real snapshot, digest and derived
 * wires, which is the right place to prove that it ARRIVES. It is the wrong
 * place to be the only proof of what it MEANS: that suite needs Docker, so on
 * a machine without a container runtime the definition is unguarded, and a
 * change to it passes the whole unit suite in silence. Verified: replacing the
 * default side of the comparison with the unnarrowed catalogue, which is the
 * exact defect the docblock warns about, left 130 unit tests green.
 *
 * So the definition gets its own fast test. The rule it pins, in one line:
 * configured means the composition the recipe resolves to differs from the one
 * the account's defaults would resolve to today, with BOTH sides narrowed by
 * the same modules.
 */

const ALL = DEFAULT_HEALTH_SCORE_CONFIG.pillars;

/** Every pillar the modules record, for an account with nothing switched off. */
const RECORDS_EVERYTHING = [...ALL];

describe("resolveScoreConfigured", () => {
  it("reads false when the person never chose", () => {
    expect(
      resolveScoreConfigured({
        config: { pillars: [...ALL] },
        recordedPillars: RECORDS_EVERYTHING,
      }),
    ).toBe(false);
  });

  it("reads true once the person's own recipe narrows the composition", () => {
    const withoutFitness = ALL.filter((id) => id !== "FITNESS");
    expect(
      resolveScoreConfigured({
        config: { pillars: withoutFitness },
        recordedPillars: RECORDS_EVERYTHING,
      }),
    ).toBe(true);
  });

  it("reads false when disabled modules alone narrow the set", () => {
    // The person authored nothing. The modules withdrew SLEEP, and both sides
    // of the comparison are narrowed by the same modules, so the difference
    // cancels. Calling this "configured" would attribute a choice to someone
    // who never made one — and it is the failure the docblock names, because
    // an unnarrowed default side produces exactly this wrong answer.
    const recorded = ALL.filter((id) => id !== "SLEEP") as ScorePillarId[];
    expect(
      resolveScoreConfigured({
        config: { pillars: [...ALL] },
        recordedPillars: recorded,
      }),
    ).toBe(false);
  });

  it("reads false when a taken-out pillar is one the modules had already withdrawn", () => {
    // The recipe removes SLEEP; the sleep module is off anyway. Nothing about
    // the composition changes, so nothing is claimed. The recipe is still
    // stored and starts mattering the day the module comes back.
    const recorded = ALL.filter((id) => id !== "SLEEP") as ScorePillarId[];
    const withoutSleep = ALL.filter((id) => id !== "SLEEP");
    expect(
      resolveScoreConfigured({
        config: { pillars: withoutSleep },
        recordedPillars: recorded,
      }),
    ).toBe(false);
  });

  it("reads true when the recipe narrows further than the modules already did", () => {
    const recorded = ALL.filter((id) => id !== "SLEEP") as ScorePillarId[];
    const alsoWithoutLipids = recorded.filter((id) => id !== "LIPIDS");
    expect(
      resolveScoreConfigured({
        config: { pillars: alsoWithoutLipids },
        recordedPillars: recorded,
      }),
    ).toBe(true);
  });

  it("reads false again when the recipe is undone", () => {
    const withoutFitness = ALL.filter((id) => id !== "FITNESS");
    expect(
      resolveScoreConfigured({
        config: { pillars: withoutFitness },
        recordedPillars: RECORDS_EVERYTHING,
      }),
    ).toBe(true);
    expect(
      resolveScoreConfigured({
        config: { pillars: [...ALL] },
        recordedPillars: RECORDS_EVERYTHING,
      }),
    ).toBe(false);
  });
});
