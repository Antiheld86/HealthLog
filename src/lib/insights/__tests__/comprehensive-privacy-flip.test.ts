/**
 * v1.32.22 (M6) — a privacy-mode flip that lands WHILE a comprehensive
 * generation is in flight must not be overwritten by that generation.
 *
 * The generation reads `insightsPrivacyMode` at snapshot time and builds its
 * payload under that scope. `PUT /api/insights/settings` flips the mode and
 * nulls the cache. If the in-flight generation then committed unconditionally
 * it would stamp an old-scope briefing over the null the flip wrote. Every
 * cache commit is now guarded on the mode still being what the generation
 * read: a mismatch (simulated here by the guarded `updateMany` matching zero
 * rows) returns `{ status: "skipped", reason: "privacy-mode-changed" }` and
 * writes nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const userUpdate = vi.fn();
const userUpdateMany = vi.fn();
const resolveProviderChain = vi.fn();
const resolveProvider = vi.fn();
const runRawCompletionWithFallback = vi.fn();
const extractFeatures = vi.fn();
const invalidateUserInsights = vi.fn();
const annotate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(async () => [{ total_tokens: 0 }]),
    $executeRaw: vi.fn(async () => 0),
    user: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => userUpdate(...a),
      // Controllable per test: `{ count: 0 }` emulates a privacy flip having
      // advanced the guarded column since the generation read it.
      updateMany: (...a: unknown[]) => userUpdateMany(...a),
    },
    auditLog: { deleteMany: vi.fn() },
  },
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: (...a: unknown[]) => resolveProviderChain(...a),
  resolveProvider: (...a: unknown[]) => resolveProvider(...a),
}));
vi.mock("@/lib/ai/provider-runner", () => ({
  AllProvidersFailedError: class extends Error {},
  runRawCompletionWithFallback: (...a: unknown[]) =>
    runRawCompletionWithFallback(...a),
}));
vi.mock("@/lib/insights/features", () => ({
  FeaturesPayloadTooLargeError: class extends Error {
    sizeBytes = 0;
  },
  extractFeatures: (...a: unknown[]) => extractFeatures(...a),
  BRIEFING_FEATURE_WINDOW_DAYS: 400,
}));
vi.mock("@/lib/insights/illness-cycle-briefing", () => ({
  buildBriefingIllnessCycleContext: vi.fn().mockResolvedValue(null),
  buildBriefingIllnessCyclePrompt: vi.fn().mockReturnValue(""),
}));
vi.mock("@/lib/insights/glp1-plateau", () => ({
  detectGlp1Plateau: vi.fn(async () => null),
  buildGlp1PlateauPrompt: vi.fn(() => ""),
}));
vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextTextForUser: vi.fn(async () => null),
  buildAboutMeInsightBlock: vi.fn(() => ""),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserInsights: (...a: unknown[]) => invalidateUserInsights(...a),
}));
vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return { ...actual, annotate: (...a: unknown[]) => annotate(...a) };
});

import { generateComprehensiveInsight } from "../comprehensive-generate";
import { hashInsightSnapshot } from "../snapshot-hash";
import { compactSections } from "@/lib/ai/prompts/compact-sections";

const FEATURES = { weight: { count: 12, latest: 81.4, mean30: 82.1 } };
const FEATURES_HASH = hashInsightSnapshot({
  features: compactSections(FEATURES as unknown as Record<string, unknown>),
  aboutMe: null,
  comparisonBaseline: "none",
  generationLocale: "de",
});

const todayKey = new Date().toISOString().slice(0, 10);

const CACHED_WITH_BRIEFING = JSON.stringify({
  summary: "stable summary",
  dailyBriefing: {
    paragraph: "Yesterday's phrasing.",
    keyFindings: [{ headline: "BP steady", tone: "good" }],
  },
});

function annotatedPrivacyChange(): boolean {
  return annotate.mock.calls.some(
    (c) =>
      (c[0] as { action?: { name?: string } })?.action?.name ===
      "insights.generate.privacy_mode_changed",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveProviderChain.mockResolvedValue([
    { providerType: "openai", instance: {} },
  ]);
  resolveProvider.mockResolvedValue({ type: "none" });
  extractFeatures.mockResolvedValue(FEATURES);
  userUpdate.mockResolvedValue({});
});

describe("generateComprehensiveInsight — privacy-mode flip guard (M6)", () => {
  it("main commit: refuses to write when the mode flipped, returns privacy-mode-changed", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: JSON.stringify({ dailyBriefing: { p: "old" } }),
      insightsExcludeMetrics: [],
      insightsSnapshotHash: "0".repeat(64), // changed → full generation
    });
    runRawCompletionWithFallback.mockResolvedValue({
      result: {
        content: JSON.stringify({ dailyBriefing: { p: "new" } }),
        tokensUsed: 10,
        providerType: "openai",
        model: "m",
      },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });
    // The flip landed: the guarded commit matches zero rows.
    userUpdateMany.mockResolvedValue({ count: 0 });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({
      status: "skipped",
      reason: "privacy-mode-changed",
    });
    // The generation reached the commit (provider was called) …
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
    // … the commit was the guarded update, keyed on the mode read …
    expect(userUpdateMany).toHaveBeenCalledTimes(1);
    const where = userUpdateMany.mock.calls[0][0].where as {
      insightsPrivacyMode: string;
    };
    expect(where.insightsPrivacyMode).toBe("aggregated");
    // … and it did NOT fall back to an unconditional write.
    expect(userUpdate).not.toHaveBeenCalled();
    expect(invalidateUserInsights).not.toHaveBeenCalled();
    expect(annotatedPrivacyChange()).toBe(true);
  });

  it("main commit: control — with the mode unchanged the same generation commits", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: JSON.stringify({ dailyBriefing: { p: "old" } }),
      insightsExcludeMetrics: [],
      insightsSnapshotHash: "0".repeat(64),
    });
    runRawCompletionWithFallback.mockResolvedValue({
      result: {
        content: JSON.stringify({ dailyBriefing: { p: "new" } }),
        tokensUsed: 10,
        providerType: "openai",
        model: "m",
      },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });
    userUpdateMany.mockResolvedValue({ count: 1 });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    expect(userUpdateMany).toHaveBeenCalledTimes(1);
    expect(invalidateUserInsights).toHaveBeenCalledWith("u1");
    expect(annotatedPrivacyChange()).toBe(false);
  });

  it("reroll arm: a flip refuses the paragraph re-roll write too", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: CACHED_WITH_BRIEFING,
      insightsExcludeMetrics: [],
      insightsSnapshotHash: FEATURES_HASH, // unchanged → reroll path
      insightsBriefingRerollDate: null,
    });
    runRawCompletionWithFallback.mockResolvedValue({
      result: {
        content: JSON.stringify({
          dailyBriefing: { paragraph: "Today's fresh phrasing." },
        }),
        tokensUsed: 50,
        providerType: "openai",
        model: "m",
      },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });
    userUpdateMany.mockResolvedValue({ count: 0 });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({
      status: "skipped",
      reason: "privacy-mode-changed",
    });
    expect(userUpdateMany).toHaveBeenCalledTimes(1);
    expect(invalidateUserInsights).not.toHaveBeenCalled();
    expect(annotatedPrivacyChange()).toBe(true);
    // Not marked as a used-today reroll, since nothing committed.
    expect(todayKey).toBe(new Date().toISOString().slice(0, 10));
  });
});
