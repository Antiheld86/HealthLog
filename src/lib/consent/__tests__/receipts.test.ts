import { describe, it, expect, vi, beforeEach } from "vitest";

// `createReceipt` runs its supersede logic inside a transaction. Run the callback against the same mock proxy. The Prisma
// `$transaction` signature is generic; the mock takes a loose callback.
type TxFn = (tx: unknown) => unknown;

vi.mock("@/lib/db", () => {
  const consentReceipt = {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  return {
    prisma: {
      consentReceipt,
      $transaction: vi.fn((fn: TxFn) => fn({ consentReceipt })),
    },
  };
});

import { prisma } from "@/lib/db";
import {
  createReceipt,
  latestActiveReceipt,
  latestActiveReceiptsByKind,
} from "../receipts";

const $transaction = vi.mocked(prisma.$transaction) as unknown as {
  mockImplementation: (impl: (fn: TxFn) => unknown) => void;
};

beforeEach(() => {
  vi.resetAllMocks();
  $transaction.mockImplementation((fn: TxFn) =>
    fn({ consentReceipt: prisma.consentReceipt }),
  );
});

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rcpt-1",
    userId: "user-1",
    kind: "ai_full",
    artefact: "PDF…",
    signedAt: new Date("2026-05-18T10:00:00.000Z"),
    revokedAt: null,
    createdAt: new Date("2026-05-18T10:00:01.000Z"),
    ...overrides,
  };
}

describe("createReceipt", () => {
  it("supersedes any active row then inserts scoped to (userId, kind)", async () => {
    vi.mocked(prisma.consentReceipt.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    vi.mocked(prisma.consentReceipt.create).mockResolvedValue(row() as never);

    const signedAt = new Date("2026-05-18T10:00:00.000Z");
    const result = await createReceipt("user-1", "ai_full", "PDF…", signedAt);

    // Revokes any currently-active receipt of the same kind first, so the
    // fresh grant doesn't collide with the partial unique index. The
    // supersede marker uses a server clock (NOT the client `signedAt`) so a
    // backdated grant can't invert the prior row's audit timestamps.
    expect(prisma.consentReceipt.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", kind: "ai_full", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.consentReceipt.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        kind: "ai_full",
        artefact: "PDF…",
        signedAt,
      },
    });
    expect(result.id).toBe("rcpt-1");
    // The whole mint runs in a transaction.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("resolves a concurrent first-grant P2002 to the winning active row (no 500)", async () => {
    // Two concurrent FIRST grants: both `updateMany` calls match 0 rows (no
    // prior active receipt, no lock under Read Committed), both reach
    // `create`, and the second trips the partial unique index with P2002.
    vi.mocked(prisma.consentReceipt.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      name: "PrismaClientKnownRequestError",
      clientVersion: "x",
    });
    vi.mocked(prisma.consentReceipt.create).mockRejectedValue(p2002 as never);
    // The concurrent grant that won is now the single active receipt.
    const winner = row({ id: "winner-row" });
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(
      winner as never,
    );

    const signedAt = new Date("2026-05-18T10:00:00.000Z");
    const result = await createReceipt("user-1", "ai_full", "PDF…", signedAt);

    // Success-shaped: returns the row the concurrent grant produced, not a
    // propagated P2002 (which the route would surface as a generic 500).
    expect(result.id).toBe("winner-row");
    expect(prisma.consentReceipt.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", kind: "ai_full", revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
  });

  it("re-throws a non-P2002 create failure", async () => {
    vi.mocked(prisma.consentReceipt.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    vi.mocked(prisma.consentReceipt.create).mockRejectedValue(
      new Error("connection reset") as never,
    );

    await expect(
      createReceipt("user-1", "ai_full", "PDF…", new Date()),
    ).rejects.toThrow("connection reset");
  });

  it("uses a server clock (not a backdated client signedAt) for the supersede marker", async () => {
    vi.mocked(prisma.consentReceipt.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    vi.mocked(prisma.consentReceipt.create).mockResolvedValue(row() as never);

    // A client backdates the grant well into the past.
    const backdated = new Date("2000-01-01T00:00:00.000Z");
    const before = Date.now();
    await createReceipt("user-1", "ai_full", "PDF…", backdated);
    const after = Date.now();

    const supersedeArg = vi.mocked(prisma.consentReceipt.updateMany).mock
      .calls[0][0] as { data: { revokedAt: Date } };
    // The prior row's revocation must be stamped "now", never the backdated
    // client value, so the audit chain can't be inverted.
    expect(supersedeArg.data.revokedAt.getTime()).not.toBe(backdated.getTime());
    expect(supersedeArg.data.revokedAt.getTime()).toBeGreaterThanOrEqual(
      before,
    );
    expect(supersedeArg.data.revokedAt.getTime()).toBeLessThanOrEqual(after);
    // The new row still carries the client signedAt.
    const createArg = vi.mocked(prisma.consentReceipt.create).mock.calls[0][0];
    expect(createArg.data.signedAt).toEqual(backdated);
  });
});

describe("latestActiveReceipt", () => {
  it("filters by user + kind + revokedAt:null and orders by createdAt desc", async () => {
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(
      row() as never,
    );

    const result = await latestActiveReceipt("user-1", "ai_full");

    expect(prisma.consentReceipt.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", kind: "ai_full", revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    expect(result?.id).toBe("rcpt-1");
  });

  it("returns null when no active receipt exists", async () => {
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(null);

    const result = await latestActiveReceipt("user-1", "ai_full");

    expect(result).toBeNull();
  });
});

describe("latestActiveReceiptsByKind", () => {
  it("returns the freshest row per kind (first-wins over createdAt desc)", async () => {
    vi.mocked(prisma.consentReceipt.findMany).mockResolvedValue([
      row({ id: "fresh-coach", kind: "ai_coach" }),
      row({ id: "fresh-full", kind: "ai_full" }),
      // Older `ai_full` row — must be ignored because we already saw
      // the freshest one above (the mock list is pre-sorted desc).
      row({ id: "older-full", kind: "ai_full" }),
    ] as never);

    const result = await latestActiveReceiptsByKind("user-1");

    expect(result.ai_full?.id).toBe("fresh-full");
    expect(result.ai_coach?.id).toBe("fresh-coach");
    expect(result.ai_insights_only).toBeUndefined();
  });
});
