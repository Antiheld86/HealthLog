import { describe, expect, it } from "vitest";

import { pickCanonicalWorkoutRows } from "../pick-canonical-workout-rows";

interface RowFixture {
  id: string;
  userId?: string;
  startedAt: Date;
  endedAt?: Date;
  durationSec?: number;
  sportType: string;
  source: "APPLE_HEALTH" | "WHOOP" | "WITHINGS" | "MANUAL" | "IMPORT";
  avgHeartRate?: number | null;
  maxHeartRate?: number | null;
  metadata?: Record<string, unknown> | null;
}

describe("pickCanonicalWorkoutRows", () => {
  it("returns the empty list unchanged for an empty input", () => {
    expect(pickCanonicalWorkoutRows([])).toEqual([]);
  });

  it("keeps a single workout regardless of source", () => {
    const rows: RowFixture[] = [
      {
        id: "w-1",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "running",
        source: "WITHINGS",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id)).toEqual(["w-1"]);
  });

  it("prefers APPLE_HEALTH over WITHINGS when both source the same workout", () => {
    const rows: RowFixture[] = [
      {
        id: "apple",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "withings",
        startedAt: new Date("2026-05-16T08:01:30Z"), // 90 s apart — same 5-min slot
        sportType: "running",
        source: "WITHINGS",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id)).toEqual(["apple"]);
  });

  it("collapses a WHOOP run and the same Apple-Health run to APPLE_HEALTH", () => {
    // The E-slice oracle for workouts (v1.11.0): a WHOOP strap and an Apple
    // Watch both log the same run within the 5-min clustering window. Apple
    // Watch GPS + HR is the richer record, so it leads the default workout
    // ladder; WHOOP ranks second. WHOOP's `start` typically differs from the
    // HealthKit `startDate` by seconds — well inside the window.
    const rows: RowFixture[] = [
      {
        id: "whoop",
        startedAt: new Date("2026-06-03T06:30:00Z"),
        sportType: "running",
        source: "WHOOP",
      },
      {
        id: "apple",
        startedAt: new Date("2026-06-03T06:30:40Z"), // 40 s apart — same slot
        sportType: "running",
        source: "APPLE_HEALTH",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id)).toEqual(["apple"]);
  });

  it("enriches a canonical Apple workout from its matched WHOOP twin", () => {
    const apple: RowFixture = {
      id: "apple",
      startedAt: new Date("2026-06-03T06:30:40Z"),
      sportType: "running",
      source: "APPLE_HEALTH",
      avgHeartRate: null,
      maxHeartRate: null,
      metadata: { hkVersion: "1", owner: "apple" },
    };
    const whoop: RowFixture = {
      id: "whoop",
      startedAt: new Date("2026-06-03T06:30:00Z"),
      sportType: "running",
      source: "WHOOP",
      avgHeartRate: 146,
      maxHeartRate: 181,
      metadata: {
        zoneDurations: {
          zone_one_milli: 60_000,
          nestedSecret: { mustNotFlow: true },
          zone_six_milli: 90_000,
        },
        whoopWorkoutStrain: 12.3,
      },
    };

    const [picked] = pickCanonicalWorkoutRows([whoop, apple]);

    expect(picked).toMatchObject({
      id: "apple",
      source: "APPLE_HEALTH",
      avgHeartRate: 146,
      maxHeartRate: 181,
      metadata: {
        hkVersion: "1",
        owner: "apple",
        zoneDurations: { zone_one_milli: 60_000 },
      },
    });
    expect((picked.metadata as Record<string, unknown>).zoneDurations).toEqual({
      zone_one_milli: 60_000,
    });
    expect(picked.metadata).not.toHaveProperty("whoopWorkoutStrain");
    expect(apple).toEqual({
      id: "apple",
      startedAt: new Date("2026-06-03T06:30:40Z"),
      sportType: "running",
      source: "APPLE_HEALTH",
      avgHeartRate: null,
      maxHeartRate: null,
      metadata: { hkVersion: "1", owner: "apple" },
    });
  });

  it("never overwrites canonical HR or zones with WHOOP donor values", () => {
    const rows: RowFixture[] = [
      {
        id: "apple",
        startedAt: new Date("2026-06-03T06:30:40Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
        avgHeartRate: 140,
        maxHeartRate: 175,
        metadata: { zoneDurations: { zone_one_milli: 30_000 } },
      },
      {
        id: "whoop",
        startedAt: new Date("2026-06-03T06:30:00Z"),
        sportType: "running",
        source: "WHOOP",
        avgHeartRate: 150,
        maxHeartRate: 185,
        metadata: { zoneDurations: { zone_one_milli: 90_000 } },
      },
    ];

    expect(pickCanonicalWorkoutRows(rows)[0]).toMatchObject({
      id: "apple",
      avgHeartRate: 140,
      maxHeartRate: 175,
      metadata: { zoneDurations: { zone_one_milli: 30_000 } },
    });
  });

  it("rejects malformed WHOOP zone durations instead of partially copying them", () => {
    const result = pickCanonicalWorkoutRows<RowFixture>([
      {
        id: "apple",
        startedAt: new Date("2026-06-03T06:30:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
        metadata: { owner: "apple" },
      },
      {
        id: "whoop",
        startedAt: new Date("2026-06-03T06:30:30Z"),
        sportType: "running",
        source: "WHOOP",
        metadata: {
          zoneDurations: {
            zone_one_milli: 60_000,
            zone_two_milli: -1,
          },
        },
      },
    ]);

    expect(result[0].metadata).toEqual({ owner: "apple" });
  });

  it("does not enrich across sport or fixed-window boundaries", () => {
    const apple: RowFixture = {
      id: "apple",
      startedAt: new Date("2026-06-03T06:30:00Z"),
      sportType: "running",
      source: "APPLE_HEALTH",
      avgHeartRate: null,
      maxHeartRate: null,
      metadata: null,
    };
    const wrongSport: RowFixture = {
      id: "whoop-cycle",
      startedAt: new Date("2026-06-03T06:30:30Z"),
      sportType: "cycling",
      source: "WHOOP",
      avgHeartRate: 150,
      maxHeartRate: 180,
      metadata: { zoneDurations: { zone_two_milli: 60_000 } },
    };
    const wrongWindow: RowFixture = {
      id: "whoop-later",
      startedAt: new Date("2026-06-03T06:35:00Z"),
      sportType: "running",
      source: "WHOOP",
      avgHeartRate: 155,
      maxHeartRate: 185,
      metadata: { zoneDurations: { zone_three_milli: 60_000 } },
    };

    const result = pickCanonicalWorkoutRows([apple, wrongSport, wrongWindow]);
    expect(result.find((row) => row.id === "apple")).toMatchObject({
      avgHeartRate: null,
      maxHeartRate: null,
      metadata: null,
    });
  });

  it("does not enrich same-source winners or use a non-WHOOP donor", () => {
    const apple: RowFixture = {
      id: "apple",
      startedAt: new Date("2026-06-03T06:30:00Z"),
      sportType: "running",
      source: "APPLE_HEALTH",
      avgHeartRate: null,
      maxHeartRate: null,
      metadata: null,
    };
    const secondApple: RowFixture = {
      ...apple,
      id: "apple-2",
      startedAt: new Date("2026-06-03T06:31:00Z"),
      avgHeartRate: 145,
      maxHeartRate: 178,
    };
    const withings: RowFixture = {
      ...apple,
      id: "withings",
      source: "WITHINGS",
      startedAt: new Date("2026-06-03T06:32:00Z"),
      avgHeartRate: 150,
      maxHeartRate: 182,
    };

    const sameSource = pickCanonicalWorkoutRows([apple, secondApple]);
    expect(sameSource[0].avgHeartRate).toBeNull();
    expect(sameSource[1].avgHeartRate).toBe(145);

    const nonWhoop = pickCanonicalWorkoutRows([apple, withings]);
    expect(nonWhoop[0]).toMatchObject({
      id: "apple",
      avgHeartRate: null,
      maxHeartRate: null,
    });
  });

  it("collapses repeated same-source sync rows with the same exact session", () => {
    const base = {
      startedAt: new Date("2026-07-29T12:54:00Z"),
      endedAt: new Date("2026-07-29T13:02:00Z"),
      durationSec: 480,
      sportType: "strength",
      source: "APPLE_HEALTH" as const,
    };
    const result = pickCanonicalWorkoutRows<RowFixture>([
      { ...base, id: "duplicate-a" },
      { ...base, id: "duplicate-b", avgHeartRate: 90 },
      { ...base, id: "duplicate-c" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("duplicate-b");
  });

  it("collapses a re-send whose endedAt disagrees with the first arrival", () => {
    // A workout with pauses has a wall-clock end that is longer than the
    // counted duration, and the two sources of that number do not always agree
    // across re-sends. `endedAt` was part of the session key when the collapse
    // first shipped, so this exact pair survived as two rows.
    const base = {
      startedAt: new Date("2026-07-29T12:54:00Z"),
      durationSec: 480,
      sportType: "cycling",
      source: "APPLE_HEALTH" as const,
    };
    const result = pickCanonicalWorkoutRows<RowFixture>([
      {
        ...base,
        id: "first-arrival",
        endedAt: new Date("2026-07-29T13:02:00Z"),
      },
      {
        ...base,
        id: "resend",
        endedAt: new Date("2026-07-29T13:09:00Z"),
        avgHeartRate: 132,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("resend");
  });

  it("keeps two same-source sessions whose durations differ", () => {
    // The counterpart guarantee: the looser key must not merge genuinely
    // distinct sessions that happen to share a bucket slot and a sport.
    const base = {
      startedAt: new Date("2026-07-29T12:54:00Z"),
      sportType: "strength",
      source: "APPLE_HEALTH" as const,
    };
    const result = pickCanonicalWorkoutRows<RowFixture>([
      { ...base, id: "short", durationSec: 480 },
      { ...base, id: "long", durationSec: 1800 },
    ]);

    expect(result.map((row) => row.id).sort()).toEqual(["long", "short"]);
  });

  it("passes rows without a duration through rather than guessing", () => {
    // Fixture-only path: a row with no duration carries no session identity, so
    // it cannot be collapsed. Every production caller selects the field and
    // `workout-canonical-identity-guard.test.ts` keeps that true.
    const base = {
      startedAt: new Date("2026-07-29T12:54:00Z"),
      sportType: "yoga",
      source: "APPLE_HEALTH" as const,
    };
    const result = pickCanonicalWorkoutRows<RowFixture>([
      { ...base, id: "no-duration-a" },
      { ...base, id: "no-duration-b" },
    ]);

    expect(result).toHaveLength(2);
  });

  it("does not collapse or enrich rows belonging to different users", () => {
    const result = pickCanonicalWorkoutRows<RowFixture>([
      {
        id: "apple-u1",
        userId: "u1",
        startedAt: new Date("2026-06-03T06:30:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
        avgHeartRate: null,
      },
      {
        id: "whoop-u2",
        userId: "u2",
        startedAt: new Date("2026-06-03T06:30:30Z"),
        sportType: "running",
        source: "WHOOP",
        avgHeartRate: 150,
      },
    ]);

    expect(result).toHaveLength(2);
    expect(
      result.find((row) => row.id === "apple-u1")?.avgHeartRate,
    ).toBeNull();
  });

  it("uses each WHOOP twin at most once for same-slot occurrences", () => {
    const result = pickCanonicalWorkoutRows<RowFixture>([
      {
        id: "apple-near",
        startedAt: new Date("2026-06-03T06:30:10Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
        avgHeartRate: null,
      },
      {
        id: "apple-far",
        startedAt: new Date("2026-06-03T06:33:30Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
        avgHeartRate: null,
      },
      {
        id: "whoop",
        startedAt: new Date("2026-06-03T06:30:00Z"),
        sportType: "running",
        source: "WHOOP",
        avgHeartRate: 150,
      },
    ]);

    expect(
      result.filter((row) => row.avgHeartRate === 150).map((row) => row.id),
    ).toEqual(["apple-near"]);
  });

  it("keeps the WHOOP run when no richer source logged the same session", () => {
    const rows: RowFixture[] = [
      {
        id: "whoop",
        startedAt: new Date("2026-06-03T06:30:00Z"),
        sportType: "running",
        source: "WHOOP",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id)).toEqual(["whoop"]);
  });

  it("does NOT collapse two distinct runs whose starts are > 5 min apart", () => {
    const rows: RowFixture[] = [
      {
        id: "first",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "second",
        startedAt: new Date("2026-05-16T08:06:00Z"), // 6 min after start — separate bucket
        sportType: "running",
        source: "APPLE_HEALTH",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("preserves same-source workouts inside one canonical slot", () => {
    const rows: RowFixture[] = [
      {
        id: "first",
        startedAt: new Date("2026-05-16T08:01:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "second",
        startedAt: new Date("2026-05-16T08:03:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
    ];

    expect(pickCanonicalWorkoutRows(rows).map((row) => row.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("does not chain neighbouring workouts across fixed canonical slots", () => {
    const rows: RowFixture[] = [
      {
        id: "first",
        startedAt: new Date("2026-05-16T08:04:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "middle",
        startedAt: new Date("2026-05-16T08:08:00Z"),
        sportType: "running",
        source: "WITHINGS",
      },
      {
        id: "last",
        startedAt: new Date("2026-05-16T08:12:00Z"),
        sportType: "running",
        source: "WITHINGS",
      },
    ];

    expect(pickCanonicalWorkoutRows(rows).map((row) => row.id)).toEqual([
      "first",
      "middle",
      "last",
    ]);
  });

  it("keeps workouts of different sports that start in the same minute", () => {
    const rows: RowFixture[] = [
      {
        id: "run",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "cycle",
        startedAt: new Date("2026-05-16T08:01:00Z"),
        sportType: "cycling",
        source: "APPLE_HEALTH",
      },
    ];
    expect(
      pickCanonicalWorkoutRows(rows)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["cycle", "run"]);
  });

  it("preserves input order on the output", () => {
    const rows: RowFixture[] = [
      {
        id: "morning",
        startedAt: new Date("2026-05-16T06:00:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "evening",
        startedAt: new Date("2026-05-16T18:00:00Z"),
        sportType: "cycling",
        source: "APPLE_HEALTH",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id)).toEqual([
      "morning",
      "evening",
    ]);
  });

  it("honours a user-supplied ladder that promotes WITHINGS over APPLE_HEALTH", () => {
    const rows: RowFixture[] = [
      {
        id: "apple",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "withings",
        startedAt: new Date("2026-05-16T08:01:00Z"),
        sportType: "running",
        source: "WITHINGS",
      },
    ];
    const userPriority = {
      metricPriority: {
        steps: ["WITHINGS", "APPLE_HEALTH", "MANUAL", "IMPORT"],
      },
    };
    expect(
      pickCanonicalWorkoutRows(rows, userPriority).map((r) => r.id),
    ).toEqual(["withings"]);
  });

  it("keeps the manual entry when no priority-ladder source claims the slot", () => {
    // Edge case: a user with both APPLE_HEALTH and WITHINGS still
    // manually recorded an "elliptical" workout the integrations
    // don't track. Manual wins by default (only entry in bucket).
    const rows: RowFixture[] = [
      {
        id: "manual",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "elliptical",
        source: "MANUAL",
      },
    ];
    expect(pickCanonicalWorkoutRows(rows).map((r) => r.id)).toEqual(["manual"]);
  });

  it("falls through to keeping every row when sources aren't on the ladder at all", () => {
    // Theoretical safety net — no real source emits a value outside
    // the canonical enum, but the picker MUST NEVER drop signal it
    // can't classify. Since v1.16.11 the resolver reconciles every
    // stored ladder against the defaults, so ANY enum source is always
    // ranked — the only unrankable rows carry a source outside the
    // enum entirely (a future source reaching an old reader).
    const rows = [
      {
        id: "a",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "running",
        source: "SOMETHING_NEW" as never,
      },
      {
        id: "b",
        startedAt: new Date("2026-05-16T08:01:00Z"),
        sportType: "running",
        source: "SOMETHING_ELSE" as never,
      },
    ] as RowFixture[];
    expect(
      pickCanonicalWorkoutRows(rows, null)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("a stored single-source ladder still resolves a canonical row (reconciled defaults rank the rest)", () => {
    // The pre-v1.16.11 contract for this input was "nothing ranked →
    // keep both"; reconciliation now appends the default ladder after
    // the stored entry, so the bucket resolves one canonical row like
    // every ranked pick.
    const rows: RowFixture[] = [
      {
        id: "a",
        startedAt: new Date("2026-05-16T08:00:00Z"),
        sportType: "running",
        source: "APPLE_HEALTH",
      },
      {
        id: "b",
        startedAt: new Date("2026-05-16T08:01:00Z"),
        sportType: "running",
        source: "WITHINGS",
      },
    ];
    const picked = pickCanonicalWorkoutRows(rows, {
      metricPriority: { steps: ["IMPORT"] },
    }).map((r) => r.id);
    expect(picked).toHaveLength(1);
  });
});
