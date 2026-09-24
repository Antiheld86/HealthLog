import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Provider-timeout fallback for the pulse-status route. When the
 * provider chain does not resolve inside `STATUS_PROVIDER_TIMEOUT_MS`
 * the route returns the deterministic no-key fallback so the
 * InsightStatusCard renders instead of spinning. It must NOT persist the
 * fallback AS AN ASSESSMENT (the pre-v1.4.28 stick-until-midnight bug);
 * `updatedAt` stays null and the served text is never a real assessment.
 *
 * v1.21.0 (coach C1 HIGH-1) — the fallback now reports `hasProvider:false`
 * (it is a deterministic, signal-grounded line, not a fresh AI assessment),
 * and the served text names the user's own value rather than a generic tip.
 *
 * v1.8.3 — the timeout path now writes a *short-TTL negative stub*
 * (`{ timeout:true, model:"timeout-stub", retryAt }`). It is explicitly
 * rejected by `readFreshStatusText`, so it can never hide the real
 * assessment; its sole purpose is to stop the read-only route re-enqueuing
 * generation on every navigation while a provider is degraded.
 */

// The graded series folds per-day aggregates in SQL; the fake folds the
// mocked `measurement.findMany` rows with the same rules.
vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    measurement: { findMany: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    // v1.28.25 — the graded-series cold-tier fallback day-buckets dense
    // types (PULSE) via a raw aggregate instead of a full findMany walk.
    $queryRaw: vi.fn(async () => []),
    moodEntry: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
  // Consent never blocks in these fixtures — the gate has its own tests.
  statusConsentBlocksGeneration: vi.fn(async () => false),
}));

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { generatePulseStatusForUser } from "../pulse-status";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);
});

describe("generatePulseStatusForUser — provider timeout fallback", () => {
  it("returns the fallback without persisting a cache row on timeout", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 72, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "timeout",
    } as never);

    const result = await generatePulseStatusForUser("user-1", {
      locale: "en",
    });

    // Honest labelling — a deterministic fallback is NOT a provider
    // assessment, so the UI can render it as the computed summary it is.
    expect(result.hasProvider).toBe(false);
    expect(result.cached).toBe(true);
    expect(typeof result.text).toBe("string");
    expect(result.text?.length ?? 0).toBeGreaterThan(0);
    // Signal-grounded — names the user's own pulse value (72), not a generic
    // clinical platitude.
    expect(result.text).toContain("72 bpm");
    // No real assessment persisted — `updatedAt` stays null so the card
    // never mislabels the fallback as a fresh assessment.
    expect(result.updatedAt).toBeNull();

    // v1.8.3 — a short-TTL negative stub IS persisted (fire-and-forget) so
    // the read-only route doesn't re-enqueue on every navigation while the
    // provider is degraded. It is marked as a timeout stub, which
    // `readFreshStatusText` rejects, so it never hides the real assessment.
    // The write is fire-and-forget (`void`), so flush the microtask queue.
    await Promise.resolve();
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const persisted = vi.mocked(prisma.auditLog.create).mock.calls[0][0] as {
      data: { details: string };
    };
    const stub = JSON.parse(persisted.data.details);
    expect(stub.timeout).toBe(true);
    expect(stub.model).toBe("timeout-stub");
    expect(typeof stub.retryAt).toBe("string");
  });
});
