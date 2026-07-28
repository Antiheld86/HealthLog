/**
 * v1.15.20 — proactive Coach nudge: deterministic-trigger unit tests.
 *
 * Pins the pure trigger predicates and the localised payload builder
 * without a DB or pg-boss boot:
 *   - compliance: < 60 % over ≥ 5 due doses fires; deliberate skips
 *     are excluded from both sides of the ratio.
 *   - bp: weekly systolic mean strictly above the effective greenMax
 *     fires; fewer than 3 readings (or no resolvable target) never does.
 *   - score: the recent 7-day mean must sit ≥ 15 points under the
 *     prior 7-day mean, with ≥ 3 samples in each window.
 *   - payload: title + body resolve per locale and fall back to the
 *     app default for null / unknown locales.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  COACH_NUDGE_COMPLIANCE_MIN_DOSES,
  COACH_NUDGE_SCORE_DROP,
  COACH_NUDGE_SLEEP_MIN_NIGHTS,
  COACH_NUDGE_TRIGGER_GROUPS,
  buildCoachNudgePayload,
  evaluateBpTrigger,
  evaluateComplianceTrigger,
  evaluateMeasurementGapTrigger,
  evaluateScoreTrigger,
  evaluateSelfContextTrigger,
  evaluateSleepDebtTrigger,
  evaluateWeightTrigger,
  findTriggerForUser,
  resolveGreetingName,
  runCoachNudgeTick,
} from "../coach-nudge";
import { getAssistantFlags } from "@/lib/feature-flags";
import { userRowHasProviderCredential } from "@/lib/ai/provider";
import {
  DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
  type HealthProfileAiSection,
} from "@/lib/validations/health-profile-facts";

vi.mock("@/lib/feature-flags", () => ({
  getAssistantFlags: vi.fn(async () => ({ coach: true })),
}));
vi.mock("@/lib/ai/provider", () => ({
  userRowHasProviderCredential: vi.fn(() => true),
}));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: vi.fn(() => "morning blood pressure"),
  encryptToBytes: vi.fn(),
}));
// The sleep-debt branch resolves the user's source priority through the
// real `@/lib/db` prisma; stub it so the unit suite stays DB-free. A
// null priority is the no-custom-priority default — `reconstructSleepNights`
// (pure) then runs normally on the stubbed measurement rows.
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => null),
}));
// v1.18.1 P4 — Rest Mode pause. Default: not in Rest Mode (every existing
// gate/trigger test stays unaffected). The pause test overrides it active.
const restModeMock = vi.hoisted(() => ({
  resolveRestMode: vi.fn(async () => ({
    active: false as boolean,
    since: null as string | null,
    episodeCount: 0,
    episodes: [] as unknown[],
  })),
}));
vi.mock("@/lib/illness/rest-mode", () => restModeMock);

function dose(taken: boolean, skipped = false, autoMissed?: boolean) {
  return {
    takenAt: taken ? new Date() : null,
    skipped,
    // An untaken, unskipped row in these fixtures models a RESOLVED miss
    // (the hourly auto-miss cron has flipped it). A still-open pending is
    // modelled explicitly with `autoMissed: false`.
    autoMissed: autoMissed ?? (!taken && !skipped),
  };
}

describe("evaluateComplianceTrigger", () => {
  it("fires below 60 % with enough due doses", () => {
    // 2 of 6 taken → 33 %.
    const rows = [
      dose(true),
      dose(true),
      dose(false),
      dose(false),
      dose(false),
      dose(false),
    ];
    expect(evaluateComplianceTrigger(rows)).toBe(true);
  });

  it("stays silent at or above 60 %", () => {
    // 4 of 6 taken → 67 %.
    const rows = [
      dose(true),
      dose(true),
      dose(true),
      dose(true),
      dose(false),
      dose(false),
    ];
    expect(evaluateComplianceTrigger(rows)).toBe(false);
  });

  it("requires the minimum due-dose floor", () => {
    const rows = Array.from(
      { length: COACH_NUDGE_COMPLIANCE_MIN_DOSES - 1 },
      () => dose(false),
    );
    expect(evaluateComplianceTrigger(rows)).toBe(false);
  });

  it("excludes deliberate skips from the ratio", () => {
    // 3 taken + 2 missed = 60 % (no fire); 4 skips must not drag the
    // denominator down into trigger territory.
    const rows = [
      dose(true),
      dose(true),
      dose(true),
      dose(false),
      dose(false),
      dose(false, true),
      dose(false, true),
      dose(false, true),
      dose(false, true),
    ];
    expect(evaluateComplianceTrigger(rows)).toBe(false);
  });

  it("excludes still-open pendings from the denominator (v1.16.1)", () => {
    // 3 taken + 2 auto-missed = 60 % (no fire). Four open pendings —
    // today's not-yet-due slots, or slots whose grace window is still
    // running (autoMissed false) — must not count as misses: with them
    // the rate would read 33 % and nudge an adherent user at 05:15.
    const rows = [
      dose(true),
      dose(true),
      dose(true),
      dose(false), // resolved miss (auto-missed)
      dose(false), // resolved miss (auto-missed)
      dose(false, false, false), // open pending
      dose(false, false, false), // open pending
      dose(false, false, false), // open pending
      dose(false, false, false), // open pending
    ];
    expect(evaluateComplianceTrigger(rows)).toBe(false);
  });
});

describe("evaluateBpTrigger", () => {
  it("fires when the weekly mean exceeds the target", () => {
    expect(evaluateBpTrigger([150, 148, 152], 135)).toBe(true);
  });

  it("stays silent when the mean sits at or under the target", () => {
    expect(evaluateBpTrigger([135, 134, 136], 135)).toBe(false);
  });

  it("requires at least 3 readings", () => {
    expect(evaluateBpTrigger([180, 180], 135)).toBe(false);
  });

  it("never fires without a resolvable target", () => {
    expect(evaluateBpTrigger([180, 180, 180], null)).toBe(false);
  });
});

describe("evaluateScoreTrigger", () => {
  it("fires on a sharp week-over-week drop", () => {
    expect(evaluateScoreTrigger([50, 52, 48], [70, 72, 68])).toBe(true);
  });

  it("stays silent under the drop threshold", () => {
    const prior = [70, 70, 70];
    const recent = prior.map((v) => v - COACH_NUDGE_SCORE_DROP + 1);
    expect(evaluateScoreTrigger(recent, prior)).toBe(false);
  });

  it("requires enough samples in both windows", () => {
    expect(evaluateScoreTrigger([40, 40], [70, 70, 70])).toBe(false);
    expect(evaluateScoreTrigger([40, 40, 40], [70, 70])).toBe(false);
  });
});

describe("findTriggerForUser RECOVERY_SCORE canonical resolution", () => {
  const NOW = new Date("2026-06-15T08:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;
  // Vitals-only so the recovery branch is the only one with data; no height /
  // dob / gender → the WEIGHT range can't resolve and that branch is skipped.
  const VITALS_ONLY = { medication: false, vitals: true, routine: false };
  const baseUser = {
    id: "u-recovery",
    heightCm: null,
    dateOfBirth: null,
    gender: null,
    thresholdsJson: null,
    timezone: "Europe/Berlin",
  };

  /** A prisma stub serving ONLY the supplied RECOVERY_SCORE rows; every other
   *  measurement read comes back empty so no other vitals trigger fires. */
  function recoveryPrisma(recoveryRows: unknown[]) {
    return {
      measurement: {
        findMany: vi.fn(async (args: { where: { type?: string } }) =>
          args.where.type === "RECOVERY_SCORE" ? recoveryRows : [],
        ),
      },
    } as unknown as PrismaClient;
  }

  /** A recovery row on a source's realistic clock. */
  function rec(iso: string, value: number, source: "WHOOP" | "COMPUTED") {
    return { value, measuredAt: new Date(iso), source };
  }

  it("does not fire when the canonical WHOOP series is stable but stray COMPUTED proxies dip", async () => {
    // Healthy, flat WHOOP-native recovery across both windows (~70). For the
    // SAME nights a low COMPUTED proxy (~40) also sits in the table. Blending
    // both — the pre-fix behaviour — would drag the recent mean down enough to
    // trip the drop trigger. Canonical resolution keeps only the WHOOP rows.
    const rows: unknown[] = [];
    for (let d = 1; d <= 12; d++) {
      const day = new Date(NOW.getTime() - d * DAY);
      const iso = day.toISOString().slice(0, 10);
      rows.push(rec(`${iso}T06:00:00Z`, 70, "WHOOP"));
      // COMPUTED proxy for the same night, filed one day earlier at noon UTC.
      const prevIso = new Date(day.getTime() - DAY).toISOString().slice(0, 10);
      rows.push(rec(`${prevIso}T12:00:00Z`, 40, "COMPUTED"));
    }
    const trigger = await findTriggerForUser(
      recoveryPrisma(rows),
      baseUser,
      NOW,
      VITALS_ONLY,
    );
    expect(trigger).not.toBe("score");
  });

  it("still fires on a genuine WHOOP-native week-over-week recovery drop", async () => {
    // No COMPUTED rows — a real native collapse from ~72 to ~50 must trigger.
    const rows: unknown[] = [];
    for (let d = 1; d <= 6; d++) {
      const day = new Date(NOW.getTime() - d * DAY).toISOString().slice(0, 10);
      rows.push(rec(`${day}T06:00:00Z`, 50, "WHOOP"));
    }
    for (let d = 8; d <= 13; d++) {
      const day = new Date(NOW.getTime() - d * DAY).toISOString().slice(0, 10);
      rows.push(rec(`${day}T06:00:00Z`, 72, "WHOOP"));
    }
    const trigger = await findTriggerForUser(
      recoveryPrisma(rows),
      baseUser,
      NOW,
      VITALS_ONLY,
    );
    expect(trigger).toBe("score");
  });
});

describe("buildCoachNudgePayload", () => {
  const ALL_TRIGGERS = [
    "compliance",
    "bp",
    "score",
    "selfContext",
    "weight",
    "sleepDebt",
    "measurementGap",
  ] as const;

  it("opens the title with a localized morning greeting and the name", () => {
    const { title, body } = buildCoachNudgePayload("bp", "de", {
      name: "Marc",
      openerSeed: 0,
    });
    expect(title).toBe("Guten Morgen, Marc");
    expect(body.length).toBeGreaterThan(0);
  });

  it("rotates to the casual opener on an odd seed", () => {
    const { title } = buildCoachNudgePayload("bp", "de", {
      name: "Marc",
      openerSeed: 1,
    });
    expect(title).toBe("Hey Marc");
  });

  it("drops the name from the greeting when none is given", () => {
    expect(buildCoachNudgePayload("score", "en", { openerSeed: 0 }).title).toBe(
      "Good morning",
    );
    expect(buildCoachNudgePayload("score", "en", { openerSeed: 1 }).title).toBe(
      "Hey there",
    );
  });

  it("falls back to the default locale for unknown locales", () => {
    const fallback = buildCoachNudgePayload("score", null, {
      name: "Sam",
      openerSeed: 0,
    });
    const unknown = buildCoachNudgePayload("score", "xx", {
      name: "Sam",
      openerSeed: 0,
    });
    expect(unknown).toEqual(fallback);
  });

  it("produces a distinct body per trigger", () => {
    const bodies = new Set(
      ALL_TRIGGERS.map((trigger) => buildCoachNudgePayload(trigger, "en").body),
    );
    expect(bodies.size).toBe(7);
  });

  it("references a Coach focus abstractly — never quoting raw text", () => {
    const { body } = buildCoachNudgePayload("bp", "en", {
      hasCoachFocus: true,
    });
    expect(body).toContain("you said you wanted to keep an eye on");
    // No interpolation token survives; no raw user sentence is read back.
    expect(body).not.toContain("{focus}");
    expect(body).not.toContain("{");
  });

  it("skips the focus note for the self-context check-up", () => {
    const plain = buildCoachNudgePayload("selfContext", "en", {
      hasCoachFocus: false,
    });
    const withFocus = buildCoachNudgePayload("selfContext", "en", {
      hasCoachFocus: true,
    });
    expect(withFocus).toEqual(plain);
  });

  it("omits the focus note when the user has no focus", () => {
    const plain = buildCoachNudgePayload("bp", "en", { hasCoachFocus: false });
    expect(buildCoachNudgePayload("bp", "en")).toEqual(plain);
  });

  it("never embeds health figures in the body", () => {
    for (const trigger of ALL_TRIGGERS) {
      const { body } = buildCoachNudgePayload(trigger, "en", {
        hasCoachFocus: true,
      });
      expect(body).not.toMatch(/\d/);
    }
  });
});

describe("resolveGreetingName", () => {
  it("prefers the display name's first token", () => {
    expect(
      resolveGreetingName({
        displayName: "Marc B.",
        fullName: "Marc Bombeck",
        username: "marc",
      }),
    ).toBe("Marc");
  });

  it("falls back to the full name's given token", () => {
    expect(
      resolveGreetingName({
        displayName: null,
        fullName: "Alex Doe",
        username: "alex",
      }),
    ).toBe("Alex");
  });

  it("uses a plain username but never an email-shaped login", () => {
    expect(
      resolveGreetingName({
        displayName: null,
        fullName: null,
        username: "alex",
      }),
    ).toBe("alex");
    expect(
      resolveGreetingName({
        displayName: null,
        fullName: null,
        username: "a@b.com",
      }),
    ).toBeNull();
  });

  it("returns null when nothing usable exists", () => {
    expect(
      resolveGreetingName({
        displayName: "   ",
        fullName: null,
        username: null,
      }),
    ).toBeNull();
  });
});

describe("evaluateWeightTrigger", () => {
  const range = { greenMin: 60, greenMax: 80 };

  it("fires when the weekly mean sits outside the range and drifts away", () => {
    expect(evaluateWeightTrigger([82, 82.5, 83], [81, 81.3, 81.5], range)).toBe(
      true,
    );
  });

  it("fires for a drift below the range too", () => {
    expect(evaluateWeightTrigger([57, 57, 57], [59, 59, 59], range)).toBe(true);
  });

  it("stays silent inside the range", () => {
    expect(evaluateWeightTrigger([79, 79, 79], [70, 70, 70], range)).toBe(
      false,
    );
  });

  it("stays silent while converging back toward the range", () => {
    expect(evaluateWeightTrigger([81, 81, 81], [83, 83, 83], range)).toBe(
      false,
    );
  });

  it("stays silent under the drift floor", () => {
    // 1.3 kg vs 1.0 kg from the range — only 0.3 kg of drift.
    expect(evaluateWeightTrigger([81.3, 81.3, 81.3], [81, 81, 81], range)).toBe(
      false,
    );
  });

  it("requires enough readings in both windows", () => {
    expect(evaluateWeightTrigger([85, 85], [81, 81, 81], range)).toBe(false);
    expect(evaluateWeightTrigger([85, 85, 85], [81, 81], range)).toBe(false);
  });

  it("never fires without a resolvable range", () => {
    expect(evaluateWeightTrigger([85, 85, 85], [81, 81, 81], null)).toBe(false);
  });
});

describe("evaluateSleepDebtTrigger", () => {
  const floor = 7; // effective greenMin; deficit means < 6.5 h.

  it("fires when 4 of 5 recorded nights clearly undershoot the floor", () => {
    expect(evaluateSleepDebtTrigger([6, 6.2, 5.9, 6.4, 7.5], floor)).toBe(true);
  });

  it("stays silent with only 3 deficit nights", () => {
    expect(evaluateSleepDebtTrigger([6, 6, 6, 7.5, 8], floor)).toBe(false);
  });

  it("does not count near-misses inside the margin as deficits", () => {
    // 6.6 h against a 7 h floor is within the 0.5 h margin.
    expect(evaluateSleepDebtTrigger([6.6, 6.6, 6.6, 6.6, 6.6], floor)).toBe(
      false,
    );
  });

  it("requires the minimum number of recorded nights", () => {
    const nights = Array.from(
      { length: COACH_NUDGE_SLEEP_MIN_NIGHTS - 1 },
      () => 5,
    );
    expect(evaluateSleepDebtTrigger(nights, floor)).toBe(false);
  });

  it("never fires without a resolvable floor", () => {
    expect(evaluateSleepDebtTrigger([5, 5, 5, 5, 5], null)).toBe(false);
  });
});

describe("evaluateMeasurementGapTrigger", () => {
  it("fires when an active account goes fully silent", () => {
    expect(evaluateMeasurementGapTrigger(12, 0)).toBe(true);
  });

  it("stays silent for a sporadically tracking account", () => {
    expect(evaluateMeasurementGapTrigger(9, 0)).toBe(false);
  });

  it("stays silent while anything still arrives", () => {
    expect(evaluateMeasurementGapTrigger(12, 1)).toBe(false);
  });
});

describe("COACH_NUDGE_TRIGGER_GROUPS", () => {
  it("maps every trigger onto its pref group", () => {
    expect(COACH_NUDGE_TRIGGER_GROUPS).toEqual({
      compliance: "medication",
      bp: "vitals",
      score: "vitals",
      weight: "vitals",
      sleepDebt: "vitals",
      measurementGap: "routine",
      selfContext: "routine",
    });
  });
});

describe("evaluateSelfContextTrigger", () => {
  const now = new Date("2026-06-10T05:15:00Z");
  const daysAgo = (days: number) =>
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const fullProfile = (updatedAt: Date) => ({
    hasAboutMe: true,
    hasConditions: true,
    hasAllergies: true,
    hasCoachFocus: true,
    updatedAt,
  });

  it("never fires without recent Coach activity", () => {
    expect(
      evaluateSelfContextTrigger({ profile: null, lastCoachUseAt: null }, now),
    ).toBe(false);
    expect(
      evaluateSelfContextTrigger(
        { profile: null, lastCoachUseAt: daysAgo(15) },
        now,
      ),
    ).toBe(false);
  });

  it("fires for an active user with no profile at all", () => {
    expect(
      evaluateSelfContextTrigger(
        { profile: null, lastCoachUseAt: daysAgo(2) },
        now,
      ),
    ).toBe(true);
  });

  it("fires for an incomplete profile", () => {
    expect(
      evaluateSelfContextTrigger(
        {
          profile: { ...fullProfile(daysAgo(1)), hasAllergies: false },
          lastCoachUseAt: daysAgo(2),
        },
        now,
      ),
    ).toBe(true);
  });

  it("fires for a complete-but-stale profile (60+ days)", () => {
    expect(
      evaluateSelfContextTrigger(
        { profile: fullProfile(daysAgo(61)), lastCoachUseAt: daysAgo(2) },
        now,
      ),
    ).toBe(true);
  });

  it("stays silent for a complete, fresh profile", () => {
    expect(
      evaluateSelfContextTrigger(
        { profile: fullProfile(daysAgo(10)), lastCoachUseAt: daysAgo(2) },
        now,
      ),
    ).toBe(false);
  });
});

/**
 * v1.16.5 — tick-level contracts: gate order, per-group prefs gating,
 * the per-user frequency cap, and the focus personalisation. The
 * Prisma client is a hand-rolled mock; flags / provider / decrypt are
 * module mocks (see the vi.mock calls at the top).
 */
describe("runCoachNudgeTick — gates and prefs", () => {
  const now = new Date("2026-06-10T05:15:00Z");
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  function userRow(notificationPrefs: unknown) {
    return {
      id: "user-1",
      locale: "en",
      notificationPrefs,
      heightCm: null,
      dateOfBirth: null,
      gender: null,
      thresholdsJson: null,
    };
  }

  function prismaMock(overrides: {
    users?: unknown[];
    intakeRows?: unknown[];
    recentNudge?: unknown;
    recentPersistedNudge?: unknown;
    recentEngagement?: unknown;
    coachFocusEncrypted?: Uint8Array | null;
    aiIncludedSections?: string[];
  }) {
    return {
      user: {
        findMany: vi.fn(async () => overrides.users ?? []),
      },
      appSettings: {
        findUnique: vi.fn(async () => ({ adminAiKeyEncrypted: "k" })),
      },
      pushAttempt: {
        findFirst: vi.fn(async (args?: unknown) => {
          void args;
          return overrides.recentNudge ?? null;
        }),
      },
      coachMessage: {
        findFirst: vi.fn(async (args?: unknown) => {
          void args;
          return overrides.recentPersistedNudge ?? null;
        }),
      },
      medicationIntakeEvent: {
        findMany: vi.fn(async () => overrides.intakeRows ?? []),
      },
      measurement: {
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 1),
      },
      coachUsage: {
        findFirst: vi.fn(async () => overrides.recentEngagement ?? null),
      },
      userHealthProfile: {
        findUnique: vi.fn(
          async (args?: { select?: Record<string, boolean> }) => {
            if (args?.select?.aiIncludedSections) {
              return {
                aiIncludedSections:
                  overrides.aiIncludedSections ??
                  DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
              };
            }
            return {
              coachFocusEncrypted: overrides.coachFocusEncrypted ?? null,
            };
          },
        ),
      },
      $queryRaw: vi.fn(async () => [{ days: 0 }]),
    };
  }

  /** Six resolved doses, one taken → 17 %, well under the 60 % gate. */
  const failingIntakes = [
    { takenAt: new Date(), skipped: false, autoMissed: false },
    ...Array.from({ length: 5 }, () => ({
      takenAt: null,
      skipped: false,
      autoMissed: true,
    })),
  ];

  beforeEach(() => {
    vi.mocked(getAssistantFlags).mockResolvedValue({
      coach: true,
    } as Awaited<ReturnType<typeof getAssistantFlags>>);
    vi.mocked(userRowHasProviderCredential).mockReturnValue(true);
    restModeMock.resolveRestMode.mockResolvedValue({
      active: false,
      since: null,
      episodeCount: 0,
      episodes: [],
    });
  });

  it("does not inspect excluded fields for the self-context trigger", async () => {
    const findUnique = vi.fn(
      async (args?: { select?: Record<string, boolean> }) => {
        expect(args?.select?.aboutMeEncrypted).toBe(true);
        expect(args?.select?.conditionsEncrypted).toBeUndefined();
        expect(args?.select?.allergiesEncrypted).toBeUndefined();
        expect(args?.select?.coachFocusEncrypted).toBeUndefined();
        return {
          aboutMeEncrypted: new Uint8Array([1]),
          updatedAt: now,
        };
      },
    );
    const prisma = {
      measurement: { count: vi.fn(async () => 1) },
      coachUsage: {
        findFirst: vi.fn(async () => ({ updatedAt: now })),
      },
      userHealthProfile: { findUnique },
    };

    const trigger = await findTriggerForUser(
      prisma as unknown as PrismaClient,
      userRow(null),
      now,
      { medication: false, vitals: false, routine: true },
      new Set<HealthProfileAiSection>(["ABOUT_ME"]),
    );

    expect(trigger).toBeNull();
    expect(findUnique).toHaveBeenCalledOnce();
  });

  it("counts a master opt-out before touching provider or cap gates", async () => {
    const prisma = prismaMock({
      users: [userRow({ coach: { nudgesEnabled: false } })],
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: vi.fn() },
    );
    expect(summary.skippedOptedOut).toBe(1);
    expect(userRowHasProviderCredential).not.toHaveBeenCalled();
    expect(prisma.pushAttempt.findFirst).not.toHaveBeenCalled();
  });

  it("treats every group disabled as opted out, not as no-trigger", async () => {
    const prisma = prismaMock({
      users: [
        userRow({
          coach: {
            nudgesEnabled: true,
            nudgeMedication: false,
            nudgeVitals: false,
            nudgeRoutine: false,
          },
        }),
      ],
      intakeRows: failingIntakes,
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: vi.fn() },
    );
    expect(summary.skippedOptedOut).toBe(1);
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
  });

  it("checks the provider gate before the frequency cap", async () => {
    vi.mocked(userRowHasProviderCredential).mockReturnValue(false);
    const prisma = prismaMock({ users: [userRow(null)] });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: vi.fn() },
    );
    expect(summary.skippedNoProvider).toBe(1);
    expect(prisma.pushAttempt.findFirst).not.toHaveBeenCalled();
  });

  it("widens the cap cutoff to 14 days for a biweekly user", async () => {
    const prisma = prismaMock({
      users: [userRow({ coach: { nudgeFrequency: "biweekly" } })],
    });
    await runCoachNudgeTick(prisma as unknown as PrismaClient, now, {
      dispatch: vi.fn(),
    });
    const arg = vi.mocked(prisma.pushAttempt.findFirst).mock.calls[0]?.[0] as
      | {
          where: { createdAt: { gte: Date } };
        }
      | undefined;
    expect(arg?.where.createdAt.gte.getTime()).toBe(
      now.getTime() - 14 * MS_PER_DAY,
    );
  });

  it("caps on a recently persisted nudge conversation even with no push-success row (M1)", async () => {
    // A no-push-channel user never writes an `ok` push-attempt row, so the
    // ledger side of gate 5 stays empty. The persisted nudge conversation
    // from a prior tick must still pin the window so the rail does not get a
    // brand-new nudge conversation every cron run.
    const dispatch = vi.fn();
    const recordNudge = vi.fn();
    const prisma = prismaMock({
      users: [userRow(null)],
      intakeRows: failingIntakes,
      recentNudge: null,
      recentPersistedNudge: { id: "msg_recent" },
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: dispatch as never, recordNudge: recordNudge as never },
    );
    expect(summary.skippedRecentNudge).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(recordNudge).not.toHaveBeenCalled();
    // The persisted-nudge query honours the same rolling cutoff as the ledger.
    const arg = vi.mocked(prisma.coachMessage.findFirst).mock.calls[0]?.[0] as
      | {
          where: {
            providerType: string;
            role: string;
            createdAt: { gte: Date };
          };
        }
      | undefined;
    expect(arg?.where.providerType).toBe("nudge");
    expect(arg?.where.role).toBe("assistant");
    expect(arg?.where.createdAt.gte.getTime()).toBe(
      now.getTime() - 7 * MS_PER_DAY,
    );
  });

  it("skips a disabled group's trigger queries entirely", async () => {
    const prisma = prismaMock({
      users: [
        userRow({
          coach: { nudgeMedication: false },
        }),
      ],
      intakeRows: failingIntakes,
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: vi.fn() },
    );
    // The would-be compliance hit is never even queried; the remaining
    // groups find nothing in the empty fixtures.
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
    expect(summary.skippedNoTrigger).toBe(1);
  });

  it("pauses the cadence-nudge during an active illness episode (Rest Mode)", async () => {
    // A user who would otherwise fire a compliance nudge (17 % adherence).
    const dispatch = vi.fn();
    restModeMock.resolveRestMode.mockResolvedValue({
      active: true,
      since: "2026-06-10T00:00:00.000Z",
      episodeCount: 1,
      episodes: [],
    });
    const prisma = prismaMock({
      users: [userRow(null)],
      intakeRows: failingIntakes,
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );
    // The nudge is paused, not penalised: no dispatch, no trigger search even
    // ran (the Rest Mode gate sits before the trigger query).
    expect(dispatch).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
    expect(summary.skippedDuringIllness).toBe(1);
    expect(summary.dispatched).toBe(0);
  });

  it("references the Coach focus abstractly — never quoting the raw text", async () => {
    const dispatch = vi.fn(async (input: unknown) => {
      void input;
      return { dispatched: true };
    });
    const prisma = prismaMock({
      users: [userRow(null)],
      intakeRows: failingIntakes,
      // Presence of the encrypted focus drives the abstract note; the bytes
      // are never decrypted by the nudge path now.
      coachFocusEncrypted: new Uint8Array([1, 2, 3]),
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: dispatch as never },
    );
    expect(summary.dispatched).toBe(1);
    const payload = dispatch.mock.calls[0]?.[0] as unknown as {
      title: string;
      message: string;
      metadata: { trigger: string };
    };
    expect(payload.metadata.trigger).toBe("compliance");
    // Title is a warm greeting; body carries the abstract focus note.
    expect(payload.title.length).toBeGreaterThan(0);
    expect(payload.message).toContain("you said you wanted to keep an eye on");
    // The decrypted self-context sentence is NEVER read back verbatim.
    expect(payload.message).not.toContain("morning blood pressure");
  });

  it("does not read or derive a Coach focus when that section is excluded", async () => {
    const dispatch = vi.fn(async (input: unknown) => {
      void input;
      return { dispatched: true };
    });
    const prisma = prismaMock({
      users: [userRow(null)],
      intakeRows: failingIntakes,
      coachFocusEncrypted: new Uint8Array([1, 2, 3]),
      aiIncludedSections: ["ABOUT_ME"],
    });

    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: dispatch as never },
    );

    expect(summary.dispatched).toBe(1);
    const payload = dispatch.mock.calls[0]?.[0] as unknown as {
      message: string;
    };
    expect(payload.message).not.toContain(
      "you said you wanted to keep an eye on",
    );
    const selectedCoachFocus =
      prisma.userHealthProfile.findUnique.mock.calls.some(([args]) =>
        Boolean(
          (args as { select?: Record<string, boolean> } | undefined)?.select
            ?.coachFocusEncrypted,
        ),
      );
    expect(selectedCoachFocus).toBe(false);
  });

  it("persists the nudge as a conversation before dispatching (CCH-02)", async () => {
    const order: string[] = [];
    const recordNudge = vi.fn(
      async (args: { userId: string; title: string; body: string }) => {
        void args;
        order.push("persist");
        return {
          conversationId: "conv_1",
          messageId: "msg_1",
          createdAt: now,
        };
      },
    );
    const dispatch = vi.fn(async () => {
      order.push("dispatch");
      return { dispatched: true };
    });
    const prisma = prismaMock({
      users: [userRow(null)],
      intakeRows: failingIntakes,
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: dispatch as never, recordNudge: recordNudge as never },
    );
    expect(summary.dispatched).toBe(1);
    expect(summary.persisted).toBe(1);
    // The conversation must be written BEFORE the notification fires so
    // the rail always carries the nudge even if the push channel is gone.
    expect(order).toEqual(["persist", "dispatch"]);
    const persistArg = recordNudge.mock.calls[0]?.[0] as unknown as {
      userId: string;
      title: string;
      body: string;
    };
    expect(persistArg.userId).toBe("user-1");
    // The persisted body is the same compliance nudge copy the
    // notification carries — it lands as the initial assistant message.
    expect(persistArg.body).toContain("Your medication routine slipped");
    expect(persistArg.title.length).toBeGreaterThan(0);
  });

  it("still dispatches + counts the nudge when persistence throws", async () => {
    const recordNudge = vi.fn(async () => {
      throw new Error("db down");
    });
    const dispatch = vi.fn(async () => ({ dispatched: true }));
    const prisma = prismaMock({
      users: [userRow(null)],
      intakeRows: failingIntakes,
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: dispatch as never, recordNudge: recordNudge as never },
    );
    // A persistence failure must not swallow the notification.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(summary.dispatched).toBe(1);
    expect(summary.persisted).toBe(0);
  });

  it("suppresses the nudge when the user engaged the Coach in the last ~24 h", async () => {
    const dispatch = vi.fn();
    const prisma = prismaMock({
      users: [userRow(null)],
      intakeRows: failingIntakes,
      recentEngagement: { userId: "user-1" },
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );
    expect(summary.skippedRecentEngagement).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    // The engagement gate sits ahead of the trigger search.
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
  });

  it("composes the body through the model when AI enrichment is opted in", async () => {
    const dispatch = vi.fn(async (input: unknown) => {
      void input;
      return { dispatched: true };
    });
    const composeAi = vi.fn(async () => ({
      title: "Guten Morgen",
      body: "AI-composed warm nudge body.",
    }));
    const prisma = prismaMock({
      users: [userRow({ coach: { nudgeAiComposed: true } })],
      intakeRows: failingIntakes,
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: dispatch as never, composeAi: composeAi as never },
    );
    expect(summary.dispatched).toBe(1);
    expect(composeAi).toHaveBeenCalledTimes(1);
    const payload = dispatch.mock.calls[0]?.[0] as unknown as {
      message: string;
    };
    expect(payload.message).toBe("AI-composed warm nudge body.");
  });

  it("falls back to the template when AI enrichment returns null", async () => {
    const dispatch = vi.fn(async (input: unknown) => {
      void input;
      return { dispatched: true };
    });
    const composeAi = vi.fn(async () => null);
    const prisma = prismaMock({
      users: [userRow({ coach: { nudgeAiComposed: true } })],
      intakeRows: failingIntakes,
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: dispatch as never, composeAi: composeAi as never },
    );
    expect(summary.dispatched).toBe(1);
    expect(composeAi).toHaveBeenCalledTimes(1);
    const payload = dispatch.mock.calls[0]?.[0] as unknown as {
      message: string;
    };
    expect(payload.message).toContain("Your medication routine slipped");
  });

  it("never calls the AI composer when enrichment is not opted in", async () => {
    const dispatch = vi.fn(async () => ({ dispatched: true }));
    const composeAi = vi.fn(async () => ({ title: "x", body: "y" }));
    const prisma = prismaMock({
      users: [userRow(null)],
      intakeRows: failingIntakes,
    });
    await runCoachNudgeTick(prisma as unknown as PrismaClient, now, {
      dispatch: dispatch as never,
      composeAi: composeAi as never,
    });
    expect(composeAi).not.toHaveBeenCalled();
  });
});
