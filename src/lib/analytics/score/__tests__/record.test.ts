/**
 * The shape of a stored score day, and the promise never to restate one.
 *
 * The database half of that promise is proved against real Postgres in
 * `tests/integration/health-score-record.test.ts`; this file covers the parts
 * a database cannot see: what the fingerprint covers, which pillars reach the
 * row, and that the write path reaches for an insert that yields rather than
 * an update that overwrites.
 */
import { describe, expect, it, vi } from "vitest";

import { HealthScoreBand } from "@/generated/prisma/client";
import { buildOk, deriveCoverage } from "@/lib/insights/derived/coverage";
import type { Derived } from "@/lib/insights/derived/types";

import { computeComposite } from "../composite";

import { UNCONFIGURED_SCORE_BOUNDARY } from "../config";
import {
  buildHealthScoreRecord,
  healthScoreInputFingerprint,
  recordHealthScore,
  SCORE_BANDS,
} from "../record";
import type {
  HealthScoreReport,
  PillarValue,
  ScorePillarId,
  ScorePillarResult,
} from "../types";
import { SCORE_VERSION } from "../types";

const NOW = new Date("2026-08-20T12:00:00.000Z");

const DOMAIN_BY_PILLAR: Record<ScorePillarId, ScorePillarResult["domain"]> = {
  BLOOD_PRESSURE: "cardiometabolic",
  GLYCAEMIA: "cardiometabolic",
  ACTIVITY: "activity",
  SLEEP: "sleep",
  ADIPOSITY: "adiposity",
  WELLBEING: "wellbeing",
  LIPIDS: "cardiometabolic",
};

function pillar(
  id: ScorePillarId,
  score: number,
  options: { deltaIdentity?: string } = {},
): ScorePillarResult {
  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: 1,
    historyDays: 28,
    missing: [],
    fullHistoryDays: 28,
  });
  const value: PillarValue = {
    score,
    observed: {
      label: `${score}`,
      value: score,
      unit: "score",
      asOf: NOW.toISOString(),
      sources: ["MANUAL"],
    },
    reference: {
      kind: "guideline-band",
      low: 0,
      high: 100,
      label: "test reference",
      source: "Test 2026",
    },
    noiseFloor: 1,
    deltaEligible: true,
    deltaIdentity: options.deltaIdentity ?? id,
  };
  const result: Derived<PillarValue> = buildOk({
    value,
    coverage,
    confidence,
    provenance: {
      inputs: [id],
      source: "live",
      windowDays: 28,
      computedAt: NOW.toISOString(),
    },
  });
  return { id, domain: DOMAIN_BY_PILLAR[id], result };
}

/** A report built through the real composite, not a hand-written envelope. */
function report(
  pillars: ScorePillarResult[],
  available = pillars.map((p) => p.id),
): HealthScoreReport {
  const composite = computeComposite({
    pillars,
    availablePillars: available,
    asOf: NOW,
    configured: false,
  });
  return {
    composite,
    pillars,
    delta: null,
    deltaReason: "no_previous_window",
    scoreVersion: SCORE_VERSION,
    weightGoal: { status: "insufficient" } as HealthScoreReport["weightGoal"],
    algorithmNotice: null,
  };
}

const HEALTHY = [
  pillar("BLOOD_PRESSURE", 88),
  pillar("SLEEP", 74),
  pillar("ADIPOSITY", 66),
];

describe("stored bands", () => {
  it("matches the band type the column actually accepts", () => {
    // The column is a Postgres enum, so a band the composite can produce and
    // the type does not carry is a constraint violation on a write path that
    // swallows its own failures — the score would keep rendering and the day
    // would silently go unrecorded. Both ends are literals: the generated
    // enum on one side, the list the writer uses on the other.
    expect(Object.values(HealthScoreBand).sort()).toEqual(
      [...SCORE_BANDS].sort(),
    );
  });

  it("lists every band the composite can produce, and nothing else", () => {
    const produced = new Set<string>();
    for (const score of [95, 85, 65, 55, 40, 20, 0]) {
      const built = report([
        pillar("BLOOD_PRESSURE", score),
        pillar("SLEEP", score),
        pillar("ADIPOSITY", score),
      ]);
      if (built.composite.status === "ok")
        produced.add(built.composite.value.band);
    }
    expect([...produced].sort()).toEqual([...SCORE_BANDS].sort());
  });
});

describe("input fingerprint", () => {
  // The fixture only needs two DIFFERENT version markers to prove the
  // fingerprint is sensitive to a version move — pinned relative to
  // SCORE_VERSION so the pair stays "previous vs current" rather than
  // going stale (or colliding) the next time the constant bumps.
  const base = {
    scoreVersion: SCORE_VERSION - 1,
    composition: ["BLOOD_PRESSURE", "SLEEP", "ADIPOSITY"] as ScorePillarId[],
    pillars: HEALTHY,
  };

  it("is stable for the same standing", () => {
    expect(healthScoreInputFingerprint(base)).toBe(
      healthScoreInputFingerprint({ ...base, pillars: [...HEALTHY].reverse() }),
    );
  });

  it("moves when the algorithm version moves", () => {
    expect(
      healthScoreInputFingerprint({ ...base, scoreVersion: SCORE_VERSION }),
    ).not.toBe(healthScoreInputFingerprint(base));
  });

  it("moves when the composition narrows", () => {
    const narrowed = {
      ...base,
      composition: ["BLOOD_PRESSURE", "SLEEP"] as ScorePillarId[],
    };
    expect(healthScoreInputFingerprint(narrowed)).not.toBe(
      healthScoreInputFingerprint(base),
    );
  });

  it("moves when a different pillar set produces the same numbers", () => {
    // Same count, same scores, same order, same scoring modes — only WHICH
    // pillars counted differs. Without the pillar id in the hash this is the
    // case that reads as an unchanged standing, and it is exactly the change
    // a configuration edit makes.
    const swapped = {
      ...base,
      composition: ["GLYCAEMIA", "SLEEP", "ADIPOSITY"] as ScorePillarId[],
      pillars: [
        pillar("GLYCAEMIA", 88, { deltaIdentity: "shared" }),
        pillar("SLEEP", 74, { deltaIdentity: "shared" }),
        pillar("ADIPOSITY", 66, { deltaIdentity: "shared" }),
      ],
    };
    const original = {
      ...base,
      pillars: [
        pillar("BLOOD_PRESSURE", 88, { deltaIdentity: "shared" }),
        pillar("SLEEP", 74, { deltaIdentity: "shared" }),
        pillar("ADIPOSITY", 66, { deltaIdentity: "shared" }),
      ],
    };
    expect(healthScoreInputFingerprint(swapped)).not.toBe(
      healthScoreInputFingerprint(original),
    );
  });

  it("moves when a counted pillar's score moves", () => {
    const shifted = {
      ...base,
      pillars: [pillar("BLOOD_PRESSURE", 87), HEALTHY[1], HEALTHY[2]],
    };
    expect(healthScoreInputFingerprint(shifted)).not.toBe(
      healthScoreInputFingerprint(base),
    );
  });

  it("moves when a pillar's scoring mode changes under an unchanged score", () => {
    // The number is identical; what produced it is not. Without the scoring
    // identity in the hash the two standings would be indistinguishable, and
    // the seam that a scoring-mode change deserves would never be drawn.
    const remoded = {
      ...base,
      pillars: [
        pillar("BLOOD_PRESSURE", 88, { deltaIdentity: "bp:personal-target" }),
        HEALTHY[1],
        HEALTHY[2],
      ],
    };
    expect(healthScoreInputFingerprint(remoded)).not.toBe(
      healthScoreInputFingerprint(base),
    );
  });

  it("ignores a pillar the composite did not count", () => {
    const withSpectator = {
      ...base,
      pillars: [...HEALTHY, pillar("ACTIVITY", 12)],
    };
    expect(healthScoreInputFingerprint(withSpectator)).toBe(
      healthScoreInputFingerprint(base),
    );
  });
});

describe("building the row", () => {
  it("records the composite, the band, and every counted pillar", () => {
    const built = report(HEALTHY);
    const draft = buildHealthScoreRecord(built, {
      timezone: "Europe/Berlin",
      now: NOW,
      config: UNCONFIGURED_SCORE_BOUNDARY,
    });
    expect(draft).not.toBeNull();
    expect(built.composite.status).toBe("ok");
    if (built.composite.status !== "ok") throw new Error("unreachable");
    expect(draft!.composite).toBe(built.composite.value.score);
    expect(draft!.band).toBe(built.composite.value.band);
    expect(draft!.composition).toEqual(built.composite.value.composition);
    expect(draft!.pillarScores).toEqual({
      BLOOD_PRESSURE: 88,
      SLEEP: 74,
      ADIPOSITY: 66,
    });
    expect(draft!.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cuts the day on the account's clock, not on UTC", () => {
    // 23:30 UTC on the 20th is already the 21st in Auckland. A row filed under
    // the UTC day would put the score on a day the person never saw it.
    const lateEvening = new Date("2026-08-20T23:30:00.000Z");
    const built = report(HEALTHY);
    expect(
      buildHealthScoreRecord(built, {
        timezone: "Pacific/Auckland",
        now: lateEvening,
        config: UNCONFIGURED_SCORE_BOUNDARY,
      })!.dayKey,
    ).toBe("2026-08-21");
    expect(
      buildHealthScoreRecord(built, {
        timezone: "UTC",
        now: lateEvening,
        config: UNCONFIGURED_SCORE_BOUNDARY,
      })!.dayKey,
    ).toBe("2026-08-20");
  });

  it("leaves out a pillar that was graded but not counted", () => {
    // ACTIVITY is available and graded, but the composite is built from the
    // three that were eligible. Storing the spectator would report a pillar
    // as contributing when it did not.
    const built = report(
      [...HEALTHY, pillar("ACTIVITY", 12)],
      ["BLOOD_PRESSURE", "SLEEP", "ADIPOSITY"],
    );
    const draft = buildHealthScoreRecord(built, {
      timezone: "UTC",
      now: NOW,
      config: UNCONFIGURED_SCORE_BOUNDARY,
    })!;
    expect(Object.keys(draft.pillarScores)).not.toContain("ACTIVITY");
    expect(draft.composition).not.toContain("ACTIVITY");
  });

  it("records a day built from a single pillar", () => {
    // Inverted from the v1.35 pin, which used a two-pillar fixture to
    // assert that a below-the-floor day stored nothing. The floor is
    // gone, so the day HAS a number and the table has to keep it: an
    // account that only tracks steps now has a history, and one that
    // begins on one pillar and widens later has an unbroken series
    // rather than a hole where its narrow days were.
    const single = report([pillar("ACTIVITY", 90)]);
    expect(single.composite.status).toBe("ok");
    const draft = buildHealthScoreRecord(single, {
      timezone: "UTC",
      now: NOW,
      config: UNCONFIGURED_SCORE_BOUNDARY,
    });
    expect(draft).not.toBeNull();
    if (!draft) return;
    expect(draft.composite).toBe(90);
    expect(draft.composition).toEqual(["ACTIVITY"]);
    expect(draft.pillarScores).toEqual({ ACTIVITY: 90 });
  });

  it("records nothing when the composite did not resolve", () => {
    // Absence still has to reach the table as absence — a stored 0 would
    // be a day the person is told they scored zero. What produces that
    // absence has narrowed to one case: not one usable pillar.
    const empty = report([]);
    expect(empty.composite.status).toBe("insufficient");
    expect(
      buildHealthScoreRecord(empty, {
        timezone: "UTC",
        now: NOW,
        config: UNCONFIGURED_SCORE_BOUNDARY,
      }),
    ).toBeNull();
  });

  it("carries the configuration version and its change date through", () => {
    const changedAt = "2026-08-19T09:00:00.000Z";
    const draft = buildHealthScoreRecord(report(HEALTHY), {
      timezone: "UTC",
      now: NOW,
      config: { version: 4, changedAt },
    })!;
    expect(draft.configVersion).toBe(4);
    expect(draft.configChangedAt).toEqual(new Date(changedAt));
  });

  it("writes an honest zero for an account that never chose, never a made-up version", () => {
    // Version 0 is a real answer — "this person never opened the surface" —
    // and it is what the seam derivation compares the first authored day
    // against. A null here would make the account's very first recipe look
    // like a row whose basis is unknown.
    const draft = buildHealthScoreRecord(report(HEALTHY), {
      timezone: "UTC",
      now: NOW,
      config: UNCONFIGURED_SCORE_BOUNDARY,
    })!;
    expect(draft.configVersion).toBe(0);
    expect(draft.configChangedAt).toBeNull();
  });
});

describe("writing the row", () => {
  /**
   * A delegate that answers `createMany` and nothing else. Reaching for
   * `upsert` or `update` throws here rather than quietly restating a day, so
   * the never-restate promise is a compile-and-run property of this file and
   * not a comment.
   */
  function delegate(count: number) {
    const createMany = vi.fn(async (args: { skipDuplicates?: boolean }) => {
      void args;
      return { count };
    });
    return {
      db: { healthScoreRecord: { createMany } } as never,
      createMany,
    };
  }

  it("inserts with a conflict that yields, and never updates", async () => {
    const { db, createMany } = delegate(1);
    const outcome = await recordHealthScore(db, "user-1", report(HEALTHY), {
      timezone: "UTC",
      now: NOW,
      config: UNCONFIGURED_SCORE_BOUNDARY,
    });
    expect(outcome).toBe("written");
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0]).toMatchObject({ skipDuplicates: true });
  });

  it("reports the day as already recorded when the insert yielded", async () => {
    const { db } = delegate(0);
    expect(
      await recordHealthScore(db, "user-1", report(HEALTHY), {
        timezone: "UTC",
        now: NOW,
        config: UNCONFIGURED_SCORE_BOUNDARY,
      }),
    ).toBe("already_recorded");
  });

  it("writes the row for a day that rests on one pillar", async () => {
    // The other half of the inverted pin: the narrow day does not just
    // build a draft, it reaches the table.
    const { db, createMany } = delegate(1);
    const single = report([pillar("ACTIVITY", 90)]);
    expect(
      await recordHealthScore(db, "user-1", single, {
        timezone: "UTC",
        now: NOW,
        config: UNCONFIGURED_SCORE_BOUNDARY,
      }),
    ).toBe("written");
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it("never touches the database when there is no score to record", async () => {
    const { db, createMany } = delegate(1);
    const thin = report([]);
    expect(
      await recordHealthScore(db, "user-1", thin, {
        timezone: "UTC",
        now: NOW,
        config: UNCONFIGURED_SCORE_BOUNDARY,
      }),
    ).toBe("no_score");
    expect(createMany).not.toHaveBeenCalled();
  });

  it("reports a failed write as failed, and does not take the read down", async () => {
    const db = {
      healthScoreRecord: {
        createMany: vi.fn(async () => {
          throw new Error("connection reset");
        }),
      },
    } as never;
    await expect(
      recordHealthScore(db, "user-1", report(HEALTHY), {
        timezone: "UTC",
        now: NOW,
        config: UNCONFIGURED_SCORE_BOUNDARY,
      }),
    ).resolves.toBe("failed");
  });
});
