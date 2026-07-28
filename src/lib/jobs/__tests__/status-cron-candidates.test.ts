/**
 * v1.15.20 — unit tests for the shared 02:xx status-cron discovery.
 *
 * Pins the three gates the discovery applies:
 *   1. the operator assistant kill-switch (`insightStatus` flag),
 *   2. the per-user `disableCoach: false` filter,
 *   3. the pregenerate-candidate skip (configured provider + stale
 *      comprehensive cache → the 04:30 pass owns the user; the 02:xx
 *      crons keep fresh-cache and provider-less accounts),
 * plus the mood-status queue registration in the worker source (the
 * v1.4.37 dead-queue class guard).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const getAssistantFlags = vi.fn();
vi.mock("@/lib/feature-flags", () => ({
  getAssistantFlags: (...a: unknown[]) => getAssistantFlags(...a),
}));

import { findStatusCronCandidates } from "../status-cron-candidates";
import { PREGENERATE_STALE_MS } from "../insight-pregenerate";

const NOW = new Date("2026-06-10T02:00:00.000Z");
const STALE_AT = new Date(NOW.getTime() - PREGENERATE_STALE_MS - 60_000);
const FRESH_AT = new Date(NOW.getTime() - 60_000);

interface FakeUserRow {
  id: string;
  locale: string | null;
  insightsCachedAt: Date | null;
  aiProvider: string | null;
  aiProviderChain: unknown;
  aiAnthropicKeyEncrypted: string | null;
  aiLocalKeyEncrypted: string | null;
  aiOpenaiKeyEncrypted: string | null;
  aiBaseUrl: string | null;
  codexConnectionStatus: string | null;
  codexAccessTokenEncrypted: string | null;
  codexRefreshTokenEncrypted: string | null;
}

function userRow(overrides: Partial<FakeUserRow> = {}): FakeUserRow {
  return {
    id: "u1",
    locale: "de",
    insightsCachedAt: null,
    aiProvider: null,
    aiProviderChain: null,
    aiAnthropicKeyEncrypted: null,
    aiLocalKeyEncrypted: null,
    aiOpenaiKeyEncrypted: null,
    aiBaseUrl: null,
    codexConnectionStatus: null,
    codexAccessTokenEncrypted: null,
    codexRefreshTokenEncrypted: null,
    ...overrides,
  };
}

function makePrisma(
  users: FakeUserRow[],
  adminAiKeyEncrypted: string | null = null,
) {
  const findMany = vi.fn().mockResolvedValue(users);
  const findUnique = vi.fn().mockResolvedValue({ adminAiKeyEncrypted });
  return {
    prisma: {
      user: { findMany },
      appSettings: { findUnique },
    },
    findMany,
    findUnique,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAssistantFlags.mockResolvedValue({
    enabled: true,
    coach: true,
    briefing: true,
    insightStatus: true,
  });
});

describe("findStatusCronCandidates — gates", () => {
  it("returns nothing when the insightStatus surface is disabled (operator kill-switch)", async () => {
    getAssistantFlags.mockResolvedValue({
      enabled: false,
      coach: false,
      briefing: false,
      insightStatus: false,
    });
    const { prisma, findMany } = makePrisma([userRow()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findStatusCronCandidates(prisma as any, NOW);
    expect(result).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("filters discovery to disableCoach: false", async () => {
    const { prisma, findMany } = makePrisma([userRow()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await findStatusCronCandidates(prisma as any, NOW);
    expect(findMany.mock.calls[0][0].where).toEqual({ disableCoach: false });
  });

  it("skips a pregenerate candidate (configured provider + stale cache)", async () => {
    const { prisma } = makePrisma([
      userRow({
        id: "stale-with-provider",
        insightsCachedAt: STALE_AT,
        aiAnthropicKeyEncrypted: "enc",
      }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findStatusCronCandidates(prisma as any, NOW);
    expect(result).toEqual([]);
  });

  it("keeps a provider user whose comprehensive cache is still fresh", async () => {
    const { prisma } = makePrisma([
      userRow({
        id: "fresh-with-provider",
        insightsCachedAt: FRESH_AT,
        aiAnthropicKeyEncrypted: "enc",
      }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findStatusCronCandidates(prisma as any, NOW);
    expect(result).toEqual([{ id: "fresh-with-provider", locale: "de" }]);
  });

  it("keeps a provider-less user even with a stale cache (no pregenerate claim)", async () => {
    const { prisma } = makePrisma([
      userRow({ id: "no-provider", insightsCachedAt: STALE_AT }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findStatusCronCandidates(prisma as any, NOW);
    expect(result).toEqual([{ id: "no-provider", locale: "de" }]);
  });

  it("counts the operator's shared admin key as a configured provider", async () => {
    const { prisma } = makePrisma(
      [userRow({ id: "admin-covered", insightsCachedAt: STALE_AT })],
      "admin-enc",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findStatusCronCandidates(prisma as any, NOW);
    expect(result).toEqual([]);
  });

  it("keeps every user when the briefing surface is off (the 04:30 pass no-ops)", async () => {
    getAssistantFlags.mockResolvedValue({
      enabled: true,
      coach: true,
      briefing: false,
      insightStatus: true,
    });
    const { prisma, findUnique } = makePrisma([
      userRow({
        id: "stale-with-provider",
        insightsCachedAt: STALE_AT,
        aiAnthropicKeyEncrypted: "enc",
      }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findStatusCronCandidates(prisma as any, NOW);
    expect(result).toEqual([{ id: "stale-with-provider", locale: "de" }]);
    // No admin-key read needed when the skip never applies.
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("mood-status queue registration (dead-queue guard)", () => {
  // v1.18.1 — the nightly status-ladder wiring moved out of the 2143-LOC
  // reminder-worker boot file into the status registrar. The dead-queue guard
  // follows the wiring there.
  const workerSrc = fs.readFileSync(
    path.resolve(__dirname, "../reminder/register-status.ts"),
    "utf8",
  );

  it("registers the queue in the allQueues createQueue loop", () => {
    const match = workerSrc.match(/const allQueues\s*=\s*\[([\s\S]*?)\];/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/\bMOOD_STATUS_QUEUE\b/);
  });

  it("schedules the 02:30 cron with the insight retry policy", () => {
    expect(workerSrc).toMatch(
      /\[\s*MOOD_STATUS_QUEUE\s*,\s*MOOD_STATUS_CRON\s*,\s*insightRetryOptions\s*\]/,
    );
    expect(workerSrc).toMatch(/MOOD_STATUS_CRON\s*=\s*"30 2 \* \* \*"/);
  });

  it("registers a createAndWork handler for the queue", () => {
    expect(workerSrc).toMatch(/createAndWork[\s\S]{0,120}MOOD_STATUS_QUEUE/);
  });

  it("drives all seven status crons through the shared discovery", () => {
    const statusSrc = fs.readFileSync(
      path.resolve(__dirname, "../reminder/insights-handlers.ts"),
      "utf8",
    );
    expect(statusSrc).toMatch(/findStatusCronCandidates\(prisma\)/);
    // The old iterate-every-user discovery must be gone from the status
    // handlers (the WHOOP/data-backup cohort reads keep their own scans).
    const statusBlock = statusSrc.slice(
      statusSrc.indexOf("async function runStatusCronGenerate"),
      statusSrc.indexOf("async function handleInsightPregenerateJob"),
    );
    expect(statusBlock).not.toMatch(/prisma\.user\.findMany/);
  });
});
