import { beforeEach, describe, expect, it, vi } from "vitest";

// The revoke and the purge run inside one transaction; the mock runs the
// callback against the same proxy. Atomicity against a real database is
// pinned by `tests/integration/consent-withdrawal-purge.test.ts`.
type TxFn = (tx: unknown) => unknown;

vi.mock("@/lib/db", () => {
  const consentReceipt = {
    updateMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
  };
  return {
    prisma: {
      consentReceipt,
      $transaction: vi.fn((fn: TxFn) => fn({ consentReceipt })),
    },
  };
});

import { prisma } from "@/lib/db";
import { withdrawConsent, type AiTextPurgeCounts } from "../withdrawal";

const COUNTS: AiTextPurgeCounts = {
  statusNotes: 3,
  briefing: 1,
  narratives: 2,
  reactionLines: 1,
  workoutParagraphs: 1,
};

const now = new Date("2026-09-20T08:00:00.000Z");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.$transaction).mockImplementation(((fn: TxFn) =>
    fn({ consentReceipt: prisma.consentReceipt })) as never);
});

/** Receipts active before the call, by kind. */
function active(kinds: string[]) {
  const live = new Set(kinds);
  vi.mocked(prisma.consentReceipt.updateMany).mockImplementation((async (args: {
    where: { kind: string };
  }) => {
    const had = live.delete(args.where.kind);
    return { count: had ? 1 : 0 };
  }) as never);
  vi.mocked(prisma.consentReceipt.findFirst).mockImplementation((async (args: {
    where: { kind: string };
  }) => ({ id: `r-${args.where.kind}`, kind: args.where.kind })) as never);
  vi.mocked(prisma.consentReceipt.count).mockImplementation(
    (async (args: { where: { kind: { in: string[] } } }) =>
      args.where.kind.in.filter((k) => live.has(k)).length) as never,
  );
}

describe("withdrawConsent", () => {
  it("revokes each active kind conditionally and re-reads it for the audit trail", async () => {
    active(["ai_coach"]);
    const purge = vi.fn();
    const result = await withdrawConsent("u1", ["ai_coach"], now, purge);
    expect(prisma.consentReceipt.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", kind: "ai_coach", revokedAt: null },
      data: { revokedAt: now },
    });
    expect(result.revoked.map((r) => r.kind)).toEqual(["ai_coach"]);
  });

  it("purges when the revoke leaves no receipt covering the analysis", async () => {
    active(["ai_full"]);
    const purge = vi.fn(async () => COUNTS);
    const result = await withdrawConsent("u1", ["ai_full"], now, purge);
    expect(purge).toHaveBeenCalledTimes(1);
    expect(result.purged).toEqual(COUNTS);
  });

  it("keeps the text while another receipt still covers the analysis", async () => {
    active(["ai_full", "ai_insights_only"]);
    const purge = vi.fn(async () => COUNTS);
    const result = await withdrawConsent("u1", ["ai_full"], now, purge);
    expect(purge).not.toHaveBeenCalled();
    expect(result.purged).toBeNull();
  });

  it("never purges for a revoke that did not touch the analysis (Coach or extraction only)", async () => {
    active(["ai_coach", "ai_extraction"]);
    const purge = vi.fn(async () => COUNTS);
    const result = await withdrawConsent(
      "u1",
      ["ai_coach", "ai_extraction"],
      now,
      purge,
    );
    expect(purge).not.toHaveBeenCalled();
    expect(result.purged).toBeNull();
    expect(result.revoked).toHaveLength(2);
  });

  it("does nothing, and purges nothing, when no receipt was active", async () => {
    active([]);
    const purge = vi.fn(async () => COUNTS);
    const result = await withdrawConsent("u1", ["ai_full"], now, purge);
    expect(result).toEqual({ revoked: [], purged: null });
    expect(prisma.consentReceipt.findFirst).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
  });

  it("propagates a purge failure out of the transaction (the revoke rolls back with it)", async () => {
    active(["ai_insights_only"]);
    const purge = vi.fn(async () => {
      throw new Error("purge failed");
    });
    await expect(
      withdrawConsent("u1", ["ai_insights_only"], now, purge),
    ).rejects.toThrow("purge failed");
  });
});
