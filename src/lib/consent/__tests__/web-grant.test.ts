import { describe, it, expect, vi, beforeEach } from "vitest";

// The web-grant mint runs its re-check + insert inside a transaction. The
// mock runs the callback against the same `prisma` proxy so the in-tx
// reads/writes share the test's mock surface. The Prisma `$transaction`
// signature is generic; the mock takes a loose callback and casts.
type TxFn = (tx: unknown) => unknown;

vi.mock("@/lib/db", () => {
  const consentReceipt = {
    create: vi.fn(),
    findFirst: vi.fn(),
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
import { ensureWebAiConsentReceipt } from "../web-grant";

const $transaction = vi.mocked(prisma.$transaction) as unknown as {
  mockImplementation: (impl: (fn: TxFn) => unknown) => void;
  mockReset: () => void;
};

beforeEach(() => {
  vi.resetAllMocks();
  // `resetAllMocks` clears the `$transaction` pass-through implementation;
  // re-arm it so the mint callback still runs against the mock surface.
  $transaction.mockImplementation((fn: TxFn) =>
    fn({ consentReceipt: prisma.consentReceipt }),
  );
});

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rcpt-web-1",
    userId: "user-1",
    kind: "ai_full",
    artefact: "{}",
    signedAt: new Date("2026-06-14T10:00:00.000Z"),
    revokedAt: null,
    createdAt: new Date("2026-06-14T10:00:01.000Z"),
    ...overrides,
  };
}

describe("ensureWebAiConsentReceipt", () => {
  it("mints an ai_full receipt when none is active", async () => {
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.consentReceipt.create).mockResolvedValue(row() as never);

    const now = new Date("2026-06-14T10:00:00.000Z");
    const result = await ensureWebAiConsentReceipt("user-1", "heal", now);

    expect(result.minted).toBe(true);
    // Reads the active master grant first (fast-path + in-tx re-check both
    // hit the same predicate).
    expect(prisma.consentReceipt.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", kind: "ai_full", revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    // The mint is wrapped in a transaction (TOCTOU close).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Mints ai_full with a web-source artefact + the supplied timestamp.
    const createArg = vi.mocked(prisma.consentReceipt.create).mock.calls[0][0];
    expect(createArg.data.userId).toBe("user-1");
    expect(createArg.data.kind).toBe("ai_full");
    expect(createArg.data.signedAt).toEqual(now);
    const artefact = JSON.parse(createArg.data.artefact as string);
    expect(artefact.source).toBe("web");
    expect(artefact.kind).toBe("ai_full");
  });

  it("is a no-op when an active ai_full receipt already exists", async () => {
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(
      row() as never,
    );

    const result = await ensureWebAiConsentReceipt("user-1", "heal");

    expect(result.minted).toBe(false);
    expect(prisma.consentReceipt.create).not.toHaveBeenCalled();
    // No transaction is opened on the already-granted fast path.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("re-checks inside the transaction: a row that appears between the fast-path read and the mint short-circuits the insert", async () => {
    // Fast-path read sees nothing; the in-tx re-check sees a row a
    // concurrent grant inserted. The mint must no-op rather than insert a
    // second active row.
    vi.mocked(prisma.consentReceipt.findFirst)
      .mockResolvedValueOnce(null) // fast path
      .mockResolvedValueOnce(row() as never); // in-tx re-check

    const result = await ensureWebAiConsentReceipt("user-1", "heal");

    expect(result.minted).toBe(false);
    expect(prisma.consentReceipt.create).not.toHaveBeenCalled();
  });

  it("maps the partial-unique violation (P2002) to a no-op when two grants race to the insert", async () => {
    // Both reads miss (the re-check loses the race too); the partial unique
    // index rejects the second insert. The structural backstop must surface
    // as success-shaped — the user ends with exactly one active receipt.
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.consentReceipt.create).mockRejectedValue({
      code: "P2002",
    } as never);

    const result = await ensureWebAiConsentReceipt("user-1", "heal");

    expect(result.minted).toBe(false);
  });

  it("rethrows non-P2002 errors", async () => {
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.consentReceipt.create).mockRejectedValue(
      new Error("connection reset") as never,
    );

    await expect(ensureWebAiConsentReceipt("user-1", "heal")).rejects.toThrow(
      "connection reset",
    );
  });
});

describe("ensureWebAiConsentReceipt — two concurrent grants", () => {
  it("yields exactly one active receipt across parallel mounts", async () => {
    // Model the race at the DB layer: a single shared "active row" slot.
    // Both callers pass the fast-path read (slot empty). The transaction
    // serialises their re-checks: the first sees the empty slot and
    // inserts; the second sees the now-filled slot and no-ops.
    let activeRow: ReturnType<typeof row> | null = null;

    vi.mocked(prisma.consentReceipt.findFirst).mockImplementation(
      (async () => activeRow) as never,
    );
    vi.mocked(prisma.consentReceipt.create).mockImplementation((async () => {
      activeRow = row();
      return activeRow;
    }) as never);
    // Serialise the two transactions so the second observes the first's
    // committed insert (Serializable isolation in production).
    let chain: Promise<unknown> = Promise.resolve();
    $transaction.mockImplementation((fn: TxFn) => {
      const run = chain.then(() =>
        fn({ consentReceipt: prisma.consentReceipt }),
      );
      chain = run.catch(() => {});
      return run;
    });

    const [a, b] = await Promise.all([
      ensureWebAiConsentReceipt("user-1", "heal"),
      ensureWebAiConsentReceipt("user-1", "heal"),
    ]);

    // Exactly one mint, exactly one row inserted.
    const mintedCount = [a, b].filter((r) => r.minted).length;
    expect(mintedCount).toBe(1);
    expect(prisma.consentReceipt.create).toHaveBeenCalledTimes(1);
  });
});

describe("ensureWebAiConsentReceipt — a revocation is a standing decision", () => {
  // The mount heal and the revocation check share one `findFirst` mock, so
  // route by predicate: `revokedAt: null` is the active-grant lookup,
  // `revokedAt: { not: null }` is the revocation-history lookup.
  function arrange({ hasRevoked }: { hasRevoked: boolean }) {
    vi.mocked(prisma.consentReceipt.findFirst).mockImplementation(
      (async (args: { where: { revokedAt?: unknown } }) => {
        const wantsRevoked =
          args.where.revokedAt !== null && args.where.revokedAt !== undefined;
        if (wantsRevoked)
          return hasRevoked
            ? (row({
                revokedAt: new Date("2026-07-01T09:00:00.000Z"),
              }) as never)
            : null;
        return null;
      }) as never,
    );
    vi.mocked(prisma.consentReceipt.create).mockResolvedValue(row() as never);
  }

  it("does not re-grant on the settings mount after the user revoked", async () => {
    arrange({ hasRevoked: true });

    const result = await ensureWebAiConsentReceipt("user-1", "heal");

    expect(result).toEqual({ minted: false, reason: "previously_revoked" });
    expect(prisma.consentReceipt.create).not.toHaveBeenCalled();
    // No transaction is opened — the decision is settled on the read.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("still heals an account that never had a receipt at all", async () => {
    arrange({ hasRevoked: false });

    const result = await ensureWebAiConsentReceipt("user-1", "heal");

    expect(result.minted).toBe(true);
    expect(prisma.consentReceipt.create).toHaveBeenCalledTimes(1);
  });

  it("lets the user grant again through an affirmative act", async () => {
    arrange({ hasRevoked: true });

    const result = await ensureWebAiConsentReceipt("user-1", "affirmative");

    expect(result.minted).toBe(true);
    expect(prisma.consentReceipt.create).toHaveBeenCalledTimes(1);
  });

  it("holds the line when the revocation lands mid-transaction", async () => {
    // The fast-path reads see a clean history; the revocation appears only
    // once the transaction is open. Without the in-transaction re-check the
    // mint would overwrite a decision made a moment earlier.
    let inTransaction = false;
    $transaction.mockImplementation((fn: TxFn) => {
      inTransaction = true;
      return fn({ consentReceipt: prisma.consentReceipt });
    });
    vi.mocked(prisma.consentReceipt.findFirst).mockImplementation(
      (async (args: { where: { revokedAt?: unknown } }) => {
        const wantsRevoked =
          args.where.revokedAt !== null && args.where.revokedAt !== undefined;
        if (wantsRevoked && inTransaction)
          return row({
            revokedAt: new Date("2026-07-01T09:00:00.000Z"),
          }) as never;
        return null;
      }) as never,
    );
    vi.mocked(prisma.consentReceipt.create).mockResolvedValue(row() as never);

    const result = await ensureWebAiConsentReceipt("user-1", "heal");

    expect(result).toEqual({ minted: false, reason: "previously_revoked" });
    expect(prisma.consentReceipt.create).not.toHaveBeenCalled();
  });
});
