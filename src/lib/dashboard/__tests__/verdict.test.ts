/**
 * Dashboard hero — verdict-ladder unit tests.
 *
 * `resolveDashboardVerdict` is pure (snapshot in, verdict out, `now`
 * injected), so the suite pins every rung, the first-hit-wins
 * precedence, and the exact boundaries the spec locked:
 *   - bpCritical fires at sys 180, not 179 (fixed floors, never user
 *     thresholds), only on a fresh reading, and outranks an overdue
 *     dose (a crisis-level reading is rung 1);
 *   - weightDrift fires at a 0.50 kg distance delta, not 0.49;
 *   - silence fires at 7 days, not 6;
 *   - scoreDrop fires at −10, not −9;
 *   - doseUpcoming is timezone-correct (next anchor must be today in
 *     the USER's zone) and never fires on a stale past `nextDueAt`
 *     with `nextDueOverdue: false` (the cached-snapshot defensive
 *     contract).
 */
import { describe, it, expect } from "vitest";

import { resolveDashboardVerdict } from "../verdict";
import { buildTargetBands } from "../snapshot";
import type { DashboardSnapshot } from "../snapshot";
import type { MedsTodayBlock } from "../meds-today";
import type { DataSummary } from "@/lib/analytics/trends";

/** Noon Berlin (CEST) on a fixed summer day. */
const NOW = new Date("2026-06-10T10:00:00.000Z");

function summary(partial: Partial<DataSummary>): DataSummary {
  return {
    count: 0,
    latest: null,
    min: null,
    max: null,
    mean: null,
    median: null,
    avg7: null,
    avg30: null,
    slope7: null,
    slope30: null,
    slope90: null,
    anomalyCount: 0,
    ...partial,
  };
}

function medsToday(partial: Partial<MedsTodayBlock> = {}): MedsTodayBlock {
  return {
    activeCount: 0,
    scheduledToday: 0,
    takenToday: 0,
    skippedToday: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    nextDueMedicationName: null,
    nextDueMedicationId: null,
    ...partial,
  };
}

function baseSnapshot(
  overrides: Partial<DashboardSnapshot> = {},
): DashboardSnapshot {
  return {
    user: {
      username: "tester",
      timezone: "Europe/Berlin",
      heightCm: null,
      dateOfBirth: null,
      gender: null,
      glucoseUnit: null,
      onboardingTourCompleted: true,
      greetingHour: 12,
    },
    layout: { version: 1, widgets: [] },
    layoutCatalogue: [],
    metricStates: {},
    targetBands: buildTargetBands({
      dateOfBirth: null,
      gender: null,
      heightCm: null,
      weightTargetOverride: null,
    }),
    tiles: {
      summaries: {},
      lastSeenByType: {},
      mood: { summary: null, entries: [] },
    },
    extras: null,
    medsToday: medsToday(),
    healthScore: null,
    briefing: null,
    briefingState: "preparing",
    briefingUpdatedAt: null,
    briefingStale: false,
    generatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function isoHoursAgo(hours: number, now: Date = NOW): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

const FRESH_FINDING = {
  tone: "info" as const,
  headline: "Steps held steady this week.",
  detail: "Daily totals stayed within the usual range.",
  delta: null,
  sourceWindow: "7d" as const,
  sourceMetric: "steps" as const,
};

const WATCH_FINDING = {
  tone: "watch" as const,
  headline: "Systolic crept up over seven days.",
  detail: "The weekly mean sits above the prior week.",
  delta: "+4 mmHg",
  sourceWindow: "7d" as const,
  sourceMetric: "bp" as const,
};

describe("rung 2 — doseOverdue", () => {
  it("fires on nextDueOverdue with the medication name and a quick-entry CTA", () => {
    const verdict = resolveDashboardVerdict(
      baseSnapshot({
        medsToday: medsToday({
          scheduledToday: 2,
          nextDueAt: isoHoursAgo(1),
          nextDueOverdue: true,
          nextDueMedicationName: "Metformin",
        }),
      }),
      NOW,
    );
    expect(verdict.variant).toBe("doseOverdue");
    expect(verdict.values).toEqual({ name: "Metformin" });
    expect(verdict.cta).toEqual({
      kind: "quickEntry",
      target: "medicationIntake",
    });
  });

  it("yields to a simultaneously critical fresh BP reading (precedence)", () => {
    // A crisis-level reading (≥ 180 / ≥ 110, ≤ 1 day old) is rung 1 —
    // it must not hide behind a routine medication prompt.
    const verdict = resolveDashboardVerdict(
      baseSnapshot({
        medsToday: medsToday({
          nextDueOverdue: true,
          nextDueMedicationName: "Metformin",
        }),
        tiles: {
          summaries: {
            BLOOD_PRESSURE_SYS: summary({ latest: 200, count: 5 }),
            BLOOD_PRESSURE_DIA: summary({ latest: 120, count: 5 }),
          },
          lastSeenByType: {
            BLOOD_PRESSURE_SYS: { lastSeenAt: isoHoursAgo(1), daysAgo: 0 },
          },
          mood: { summary: null, entries: [] },
        },
      }),
      NOW,
    );
    expect(verdict.variant).toBe("bpCritical");
  });

  it("wins over the BP rung once the critical reading has aged past a day", () => {
    const verdict = resolveDashboardVerdict(
      baseSnapshot({
        medsToday: medsToday({
          nextDueOverdue: true,
          nextDueMedicationName: "Metformin",
        }),
        tiles: {
          summaries: {
            BLOOD_PRESSURE_SYS: summary({ latest: 200, count: 5 }),
            BLOOD_PRESSURE_DIA: summary({ latest: 120, count: 5 }),
          },
          lastSeenByType: {
            BLOOD_PRESSURE_SYS: { lastSeenAt: isoHoursAgo(3 * 24), daysAgo: 3 },
          },
          mood: { summary: null, entries: [] },
        },
      }),
      NOW,
    );
    expect(verdict.variant).toBe("doseOverdue");
  });

  it("never renders overdue from a stale past nextDueAt with the flag false", () => {
    // Cached-snapshot defensive contract: the anchor passed AFTER the
    // snapshot was built, so the flag is still false — plain summary.
    const verdict = resolveDashboardVerdict(
      baseSnapshot({
        medsToday: medsToday({
          scheduledToday: 1,
          nextDueAt: isoHoursAgo(1),
          nextDueOverdue: false,
          nextDueMedicationName: "Metformin",
        }),
      }),
      NOW,
    );
    expect(verdict.variant).toBe("allQuiet");
  });
});

describe("rung 1 — bpCritical", () => {
  function bpSnapshot(
    sys: number | null,
    dia: number | null,
    lastSeenAt: string,
  ): DashboardSnapshot {
    return baseSnapshot({
      tiles: {
        summaries: {
          ...(sys !== null && {
            BLOOD_PRESSURE_SYS: summary({ latest: sys, count: 5 }),
          }),
          ...(dia !== null && {
            BLOOD_PRESSURE_DIA: summary({ latest: dia, count: 5 }),
          }),
        },
        lastSeenByType: {
          BLOOD_PRESSURE_SYS: { lastSeenAt, daysAgo: 0 },
        },
        mood: { summary: null, entries: [] },
      },
    });
  }

  it("fires at the fixed systolic floor 180 with a fresh reading", () => {
    const verdict = resolveDashboardVerdict(
      bpSnapshot(180, 95, isoHoursAgo(2)),
      NOW,
    );
    expect(verdict.variant).toBe("bpCritical");
    expect(verdict.values).toEqual({ sys: 180, dia: 95 });
    expect(verdict.cta).toEqual({
      kind: "link",
      href: "/insights/blood-pressure",
    });
  });

  it("does NOT fire at 179 (boundary)", () => {
    const verdict = resolveDashboardVerdict(
      bpSnapshot(179, 95, isoHoursAgo(2)),
      NOW,
    );
    expect(verdict.variant).toBe("allQuiet");
  });

  it("fires on the canonical diastolic crisis floor 120 alone", () => {
    // D3-H1: the hero's diastolic crisis floor is now 120 (ACC/AHA), bound to
    // `@/lib/clinical-floors`, so the hero, the notification engine, and the
    // Coach acute clause agree on the same reading.
    const verdict = resolveDashboardVerdict(
      bpSnapshot(150, 120, isoHoursAgo(2)),
      NOW,
    );
    expect(verdict.variant).toBe("bpCritical");
    expect(verdict.values).toEqual({ sys: 150, dia: 120 });
  });

  it("does NOT fire at dia 119 (boundary)", () => {
    const verdict = resolveDashboardVerdict(
      bpSnapshot(150, 119, isoHoursAgo(2)),
      NOW,
    );
    expect(verdict.variant).toBe("allQuiet");
  });

  it("stays quiet at dia 112 — the former 110 floor no longer fires alone", () => {
    // The cross-surface contradiction this fix closes: 170/112 used to light
    // the hero banner yet never tripped the alarm or the Coach acute number.
    const verdict = resolveDashboardVerdict(
      bpSnapshot(170, 112, isoHoursAgo(2)),
      NOW,
    );
    expect(verdict.variant).toBe("allQuiet");
  });

  it("skips a critical-valued reading older than one day", () => {
    const verdict = resolveDashboardVerdict(
      bpSnapshot(190, 120, isoHoursAgo(3 * 24)),
      NOW,
    );
    expect(verdict.variant).toBe("allQuiet");
  });

  it("still fires inside the one-day freshness window (daysAgo floor 1)", () => {
    const verdict = resolveDashboardVerdict(
      bpSnapshot(190, 120, isoHoursAgo(36)),
      NOW,
    );
    expect(verdict.variant).toBe("bpCritical");
  });

  it("re-derives freshness from the injected now, not the snapshot daysAgo", () => {
    // The snapshot claims daysAgo: 0 (computed at build time), but the
    // injected `now` sits three days later — the rung must skip.
    const snap = bpSnapshot(190, 120, isoHoursAgo(1));
    const later = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
    expect(resolveDashboardVerdict(snap, later).variant).toBe("allQuiet");
    // Same snapshot evaluated at its build instant fires.
    expect(resolveDashboardVerdict(snap, NOW).variant).toBe("bpCritical");
  });
});

describe("rung 3 — doseUpcoming", () => {
  function upcomingSnapshot(
    nextDueAt: string,
    tz = "Europe/Berlin",
  ): DashboardSnapshot {
    const snap = baseSnapshot({
      medsToday: medsToday({
        scheduledToday: 2,
        takenToday: 1,
        skippedToday: 0,
        nextDueAt,
        nextDueOverdue: false,
        nextDueMedicationName: "Ramipril",
      }),
    });
    snap.user.timezone = tz;
    return snap;
  }

  it("fires for a dose due within two hours today, with local HH:mm", () => {
    // 11:30 UTC = 13:30 Berlin (CEST).
    const verdict = resolveDashboardVerdict(
      upcomingSnapshot("2026-06-10T11:30:00.000Z"),
      NOW,
    );
    expect(verdict.variant).toBe("doseUpcoming");
    expect(verdict.values).toEqual({ time: "13:30", name: "Ramipril" });
    expect(verdict.cta).toEqual({
      kind: "quickEntry",
      target: "medicationIntake",
    });
  });

  it("does NOT fire when the dose is more than two hours away", () => {
    const verdict = resolveDashboardVerdict(
      upcomingSnapshot("2026-06-10T12:30:00.000Z"),
      NOW,
    );
    expect(verdict.variant).toBe("allQuiet");
  });

  it("fires exactly at the two-hour boundary", () => {
    const verdict = resolveDashboardVerdict(
      upcomingSnapshot("2026-06-10T12:00:00.000Z"),
      NOW,
    );
    expect(verdict.variant).toBe("doseUpcoming");
  });

  it("does NOT fire when the next anchor falls on tomorrow in the user's zone", () => {
    // 23:30 Berlin: a dose 1 h away sits at 00:30 LOCAL tomorrow even
    // though it is still 2026-06-10 in UTC terms of distance.
    const lateNow = new Date("2026-06-10T21:30:00.000Z"); // 23:30 Berlin
    const verdict = resolveDashboardVerdict(
      upcomingSnapshot("2026-06-10T22:30:00.000Z"),
      lateNow,
    );
    expect(verdict.variant).toBe("allQuiet");
  });

  it("respects a non-European zone for the same instants", () => {
    // Pacific/Auckland (UTC+12, no DST in June): 10:00 UTC = 22:00
    // local; a dose at 11:30 UTC = 23:30 local is still TODAY there.
    const verdict = resolveDashboardVerdict(
      upcomingSnapshot("2026-06-10T11:30:00.000Z", "Pacific/Auckland"),
      NOW,
    );
    expect(verdict.variant).toBe("doseUpcoming");
    expect(verdict.values).toEqual({ time: "23:30", name: "Ramipril" });
  });

  it("does NOT fire when every scheduled dose is already resolved", () => {
    const snap = upcomingSnapshot("2026-06-10T11:30:00.000Z");
    snap.medsToday.takenToday = 1;
    snap.medsToday.skippedToday = 1; // 2 scheduled, 2 resolved
    expect(resolveDashboardVerdict(snap, NOW).variant).toBe("allQuiet");
  });
});

describe("rung 4 — weightDrift", () => {
  // height 180 cm → green band [59.94, 80.676] kg.
  const GREEN_MAX_180 = 24.9 * 1.8 * 1.8;

  function weightSnapshot(
    avg7: number | null,
    avg30: number | null,
    heightCm: number | null = 180,
    weightTargetOverride: { min: number; max: number } | null = null,
  ): DashboardSnapshot {
    const snap = baseSnapshot({
      tiles: {
        summaries: {
          WEIGHT: summary({ latest: avg7, avg7, avg30, count: 20 }),
        },
        lastSeenByType: {
          WEIGHT: { lastSeenAt: isoHoursAgo(2), daysAgo: 0 },
        },
        mood: { summary: null, entries: [] },
      },
    });
    snap.user.heightCm = heightCm;
    // v1.34 — the rung reads the snapshot's RESOLVED band, so the fixture
    // resolves it the same way the builder does.
    snap.targetBands = buildTargetBands({
      dateOfBirth: null,
      gender: null,
      heightCm,
      weightTargetOverride,
    });
    return snap;
  }

  it("fires at exactly the 0.50 kg drift threshold", () => {
    // avg30 inside the band (distance 0), avg7 exactly 0.5 kg outside.
    const verdict = resolveDashboardVerdict(
      weightSnapshot(GREEN_MAX_180 + 0.5, GREEN_MAX_180 - 1),
      NOW,
    );
    expect(verdict.variant).toBe("weightDrift");
    expect(verdict.cta).toEqual({ kind: "link", href: "/insights/weight" });
  });

  it("does NOT fire at 0.49 kg drift (boundary)", () => {
    const verdict = resolveDashboardVerdict(
      weightSnapshot(GREEN_MAX_180 + 0.49, GREEN_MAX_180 - 1),
      NOW,
    );
    expect(verdict.variant).toBe("allQuiet");
  });

  it("skips entirely when no height and no target (no band at all)", () => {
    const verdict = resolveDashboardVerdict(
      weightSnapshot(GREEN_MAX_180 + 5, GREEN_MAX_180 - 1, null),
      NOW,
    );
    expect(verdict.variant).toBe("allQuiet");
  });

  it("skips when avg7 or avg30 is null", () => {
    expect(resolveDashboardVerdict(weightSnapshot(null, 75), NOW).variant).toBe(
      "allQuiet",
    );
    expect(
      resolveDashboardVerdict(weightSnapshot(GREEN_MAX_180 + 5, null), NOW)
        .variant,
    ).toBe("allQuiet");
  });

  it("stays silent while converging back toward the range", () => {
    // avg7 closer to the band than avg30 — drift is negative.
    const verdict = resolveDashboardVerdict(
      weightSnapshot(GREEN_MAX_180 + 1, GREEN_MAX_180 + 3),
      NOW,
    );
    expect(verdict.variant).toBe("allQuiet");
  });
});

describe("rung 5 — shortNights", () => {
  function sleepSnapshot(
    avg7: number | null,
    count: number,
  ): DashboardSnapshot {
    return baseSnapshot({
      tiles: {
        summaries: {
          SLEEP_DURATION: summary({ avg7, count, latest: avg7 }),
        },
        lastSeenByType: {
          SLEEP_DURATION: { lastSeenAt: isoHoursAgo(8), daysAgo: 0 },
        },
        mood: { summary: null, entries: [] },
      },
    });
  }

  it("fires under the clear-margin floor (6.5 h) with enough readings", () => {
    const verdict = resolveDashboardVerdict(sleepSnapshot(360, 7), NOW);
    expect(verdict.variant).toBe("shortNights");
    expect(verdict.values).toEqual({ hours: 6 });
    expect(verdict.cta).toEqual({ kind: "link", href: "/insights/sleep" });
  });

  it("fires just under the 390-minute floor, not at it (boundary)", () => {
    expect(resolveDashboardVerdict(sleepSnapshot(389, 7), NOW).variant).toBe(
      "shortNights",
    );
    expect(resolveDashboardVerdict(sleepSnapshot(390, 7), NOW).variant).toBe(
      "allQuiet",
    );
  });

  it("stays silent on a sparse week (fewer than 5 readings)", () => {
    expect(resolveDashboardVerdict(sleepSnapshot(300, 4), NOW).variant).toBe(
      "allQuiet",
    );
  });
});

describe("rung 6 — silence", () => {
  function silenceSnapshot(
    seen: Record<string, { lastSeenAt: string; daysAgo: number } | null>,
  ): DashboardSnapshot {
    return baseSnapshot({
      tiles: {
        summaries: {},
        lastSeenByType: seen,
        mood: { summary: null, entries: [] },
      },
    });
  }

  it("fires when every logged-ever core vital is silent for ≥ 7 days", () => {
    const verdict = resolveDashboardVerdict(
      silenceSnapshot({
        WEIGHT: { lastSeenAt: isoHoursAgo(8 * 24), daysAgo: 8 },
        BLOOD_PRESSURE_SYS: { lastSeenAt: isoHoursAgo(9 * 24), daysAgo: 9 },
        // glucose never logged — excluded from the min.
      }),
      NOW,
    );
    expect(verdict.variant).toBe("silence");
    expect(verdict.values).toEqual({ days: 8 });
    expect(verdict.cta).toEqual({ kind: "quickEntry", target: "measurement" });
  });

  it("does NOT fire at 6 days (boundary), fires at exactly 7", () => {
    expect(
      resolveDashboardVerdict(
        silenceSnapshot({
          WEIGHT: { lastSeenAt: isoHoursAgo(6 * 24), daysAgo: 6 },
        }),
        NOW,
      ).variant,
    ).toBe("allQuiet");
    expect(
      resolveDashboardVerdict(
        silenceSnapshot({
          WEIGHT: { lastSeenAt: isoHoursAgo(7 * 24), daysAgo: 7 },
        }),
        NOW,
      ).variant,
    ).toBe("silence");
  });

  it("a single fresh vital silences the rung (min, not max)", () => {
    const verdict = resolveDashboardVerdict(
      silenceSnapshot({
        WEIGHT: { lastSeenAt: isoHoursAgo(30 * 24), daysAgo: 30 },
        BLOOD_GLUCOSE: { lastSeenAt: isoHoursAgo(2), daysAgo: 0 },
      }),
      NOW,
    );
    expect(verdict.variant).toBe("allQuiet");
  });

  it("skips when none of the three vitals was ever logged", () => {
    expect(resolveDashboardVerdict(silenceSnapshot({}), NOW).variant).toBe(
      "allQuiet",
    );
  });
});

describe("rung 7 — scoreDrop", () => {
  function scoreSnapshot(delta: number | null): DashboardSnapshot {
    return baseSnapshot({
      healthScore: {
        score: 60,
        band: "yellow",
        delta,
        deltaReason: null,
      },
    });
  }

  it("fires at a −10 delta (boundary)", () => {
    const verdict = resolveDashboardVerdict(scoreSnapshot(-10), NOW);
    expect(verdict.variant).toBe("scoreDrop");
    expect(verdict.values).toEqual({ points: 10 });
    expect(verdict.cta).toEqual({ kind: "link", href: "/insights" });
  });

  it("does NOT fire at −9 (boundary)", () => {
    expect(resolveDashboardVerdict(scoreSnapshot(-9), NOW).variant).toBe(
      "allQuiet",
    );
  });

  it("skips a null delta and a null score block", () => {
    expect(resolveDashboardVerdict(scoreSnapshot(null), NOW).variant).toBe(
      "allQuiet",
    );
    expect(
      resolveDashboardVerdict(baseSnapshot({ healthScore: null }), NOW).variant,
    ).toBe("allQuiet");
  });
});

describe("rung 8 — briefing", () => {
  it("renders the first watch-tone headline verbatim from a fresh briefing", () => {
    const verdict = resolveDashboardVerdict(
      baseSnapshot({
        briefing: {
          paragraph: "Calm day overall.",
          keyFindings: [FRESH_FINDING, WATCH_FINDING],
        },
        briefingState: "ready",
        briefingStale: false,
        briefingUpdatedAt: NOW.toISOString(),
      }),
      NOW,
    );
    expect(verdict.variant).toBe("briefing");
    expect(verdict.values).toEqual({
      headline: WATCH_FINDING.headline,
      sourceMetric: WATCH_FINDING.sourceMetric,
    });
    expect(verdict.cta).toEqual({ kind: "link", href: "/insights" });
  });

  it("falls back to the first finding when no watch tone exists", () => {
    const verdict = resolveDashboardVerdict(
      baseSnapshot({
        briefing: {
          paragraph: "Calm day overall.",
          keyFindings: [FRESH_FINDING],
        },
        briefingState: "ready",
        briefingStale: false,
      }),
      NOW,
    );
    expect(verdict.variant).toBe("briefing");
    expect(verdict.values).toEqual({
      headline: FRESH_FINDING.headline,
      sourceMetric: FRESH_FINDING.sourceMetric,
    });
  });

  it("skips a STALE briefing even in ready-shaped delivery", () => {
    const verdict = resolveDashboardVerdict(
      baseSnapshot({
        briefing: {
          paragraph: "Yesterday's text.",
          keyFindings: [WATCH_FINDING],
        },
        briefingState: "preparing",
        briefingStale: true,
      }),
      NOW,
    );
    expect(verdict.variant).toBe("allQuiet");
  });

  it("skips ready + stale (belt and braces on the two flags)", () => {
    const verdict = resolveDashboardVerdict(
      baseSnapshot({
        briefing: {
          paragraph: "Old text.",
          keyFindings: [WATCH_FINDING],
        },
        briefingState: "ready",
        briefingStale: true,
      }),
      NOW,
    );
    expect(verdict.variant).toBe("allQuiet");
  });

  it("skips an empty keyFindings array", () => {
    const verdict = resolveDashboardVerdict(
      baseSnapshot({
        briefing: { paragraph: "Flat data day.", keyFindings: [] },
        briefingState: "ready",
        briefingStale: false,
      }),
      NOW,
    );
    expect(verdict.variant).toBe("allQuiet");
  });
});

describe("rung 9 — allQuiet + full-ladder precedence", () => {
  it("returns allQuiet with no CTA on an empty snapshot", () => {
    const verdict = resolveDashboardVerdict(baseSnapshot(), NOW);
    expect(verdict).toEqual({ variant: "allQuiet", values: {}, cta: null });
  });

  it("bpCritical outranks every lower rung when stacked", () => {
    // BP critical + short nights + score drop + fresh briefing — the
    // ladder must stop at rung 2.
    const verdict = resolveDashboardVerdict(
      baseSnapshot({
        tiles: {
          summaries: {
            BLOOD_PRESSURE_SYS: summary({ latest: 185, count: 5 }),
            BLOOD_PRESSURE_DIA: summary({ latest: 100, count: 5 }),
            SLEEP_DURATION: summary({ avg7: 300, count: 7 }),
          },
          lastSeenByType: {
            BLOOD_PRESSURE_SYS: { lastSeenAt: isoHoursAgo(1), daysAgo: 0 },
            SLEEP_DURATION: { lastSeenAt: isoHoursAgo(8), daysAgo: 0 },
          },
          mood: { summary: null, entries: [] },
        },
        healthScore: {
          score: 40,
          band: "red",
          delta: -20,
          deltaReason: null,
        },
        briefing: {
          paragraph: "Busy day.",
          keyFindings: [WATCH_FINDING],
        },
        briefingState: "ready",
        briefingStale: false,
      }),
      NOW,
    );
    expect(verdict.variant).toBe("bpCritical");
  });

  it("scoreDrop outranks the briefing teaser", () => {
    const verdict = resolveDashboardVerdict(
      baseSnapshot({
        healthScore: {
          score: 50,
          band: "yellow",
          delta: -15,
          deltaReason: null,
        },
        briefing: {
          paragraph: "Busy day.",
          keyFindings: [WATCH_FINDING],
        },
        briefingState: "ready",
        briefingStale: false,
      }),
      NOW,
    );
    expect(verdict.variant).toBe("scoreDrop");
    expect(verdict.values).toEqual({ points: 15 });
  });
});

/**
 * v1.34 — the weight-drift rung measures against the band the user actually
 * reads. It used to recompute the height-derived BMI band inline, so it kept
 * nudging about drift away from a band an explicit target had replaced.
 */
describe("rung 4 — weightDrift honours an explicit target", () => {
  function driftSnapshot(
    avg7: number,
    avg30: number,
    weightTargetOverride: { min: number; max: number } | null,
  ): DashboardSnapshot {
    const snap = baseSnapshot({
      tiles: {
        summaries: {
          WEIGHT: summary({ latest: avg7, avg7, avg30, count: 20 }),
        },
        lastSeenByType: {
          WEIGHT: { lastSeenAt: isoHoursAgo(2), daysAgo: 0 },
        },
        mood: { summary: null, entries: [] },
      },
    });
    snap.user.heightCm = 180;
    snap.targetBands = buildTargetBands({
      dateOfBirth: null,
      gender: null,
      heightCm: 180,
      weightTargetOverride,
    });
    return snap;
  }

  it("stays quiet inside the user's own band even when the BMI band would fire", () => {
    // 82 / 81 kg is above the height-derived green max (80.68) and drifting
    // away from it, but sits inside a self-set 78-85 kg band.
    expect(
      resolveDashboardVerdict(driftSnapshot(82, 81, null), NOW).variant,
    ).toBe("weightDrift");
    expect(
      resolveDashboardVerdict(driftSnapshot(82, 81, { min: 78, max: 85 }), NOW)
        .variant,
    ).toBe("allQuiet");
  });

  it("fires on drift away from the user's own band", () => {
    expect(
      resolveDashboardVerdict(driftSnapshot(72, 74, { min: 78, max: 85 }), NOW)
        .variant,
    ).toBe("weightDrift");
  });
});
