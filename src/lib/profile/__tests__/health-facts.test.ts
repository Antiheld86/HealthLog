import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  userUpdate: vi.fn(),
  invalidateInsights: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    healthProfileFactRevision: {
      create: mocks.create,
      findMany: mocks.findMany,
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: mocks.encrypt,
  decryptFromBytes: mocks.decrypt,
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserInsights: mocks.invalidateInsights,
}));
vi.mock("@/lib/logging/context", () => ({ getEvent: vi.fn(() => null) }));

import {
  correctHealthProfileFact,
  invalidateHealthProfileFactConsumers,
  createHealthProfileFact,
  decryptHealthProfileFactValue,
  readHealthProfileFacts,
  removeHealthProfileFact,
} from "../health-facts";

const encoder = new TextEncoder();
const initial = new Date("2026-07-28T10:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "fact-1",
    kind: "SMOKING_STATUS",
    valueEncrypted: encoder.encode("FORMER"),
    validFrom: initial,
    validUntil: null,
    provenance: "USER_REPORTED",
    supersededByRevisionId: null,
    createdAt: initial,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.encrypt.mockImplementation((value: string) =>
    encoder.encode(`encrypted:${value}`),
  );
  mocks.decrypt.mockImplementation((value: Uint8Array) => {
    const decoded = new TextDecoder().decode(value);
    return decoded.replace(/^encrypted:/, "");
  });
  mocks.transaction.mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        healthProfileFactRevision: {
          findFirst: mocks.findFirst,
          updateMany: mocks.updateMany,
          create: mocks.create,
          update: mocks.update,
        },
        user: { update: mocks.userUpdate },
      }),
  );
});

describe("encrypted health profile fact revisions", () => {
  it("clears persisted and in-memory insight caches through the supplied transaction client", async () => {
    mocks.userUpdate.mockResolvedValue({});

    await invalidateHealthProfileFactConsumers("user-1", {
      user: { update: mocks.userUpdate },
    } as never);

    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        insightsCachedAt: null,
        insightsCachedText: null,
        insightsCachedLocale: null,
      },
    });
    expect(mocks.invalidateInsights).toHaveBeenCalledWith("user-1");
  });

  it("encrypts the answer before the create delegate receives it", async () => {
    mocks.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) =>
        row({
          valueEncrypted: data.valueEncrypted,
          validFrom: data.validFrom,
        }),
    );

    const created = await createHealthProfileFact(
      "user-1",
      "SMOKING_STATUS",
      "FORMER",
      initial,
    );

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          kind: "SMOKING_STATUS",
          valueEncrypted: encoder.encode("encrypted:FORMER"),
          validFrom: initial,
          provenance: "USER_REPORTED",
        }),
      }),
    );
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        insightsCachedAt: null,
        insightsCachedText: null,
        insightsCachedLocale: null,
      },
    });
    expect(JSON.stringify(mocks.create.mock.calls[0][0].data)).not.toContain(
      '"value":"FORMER"',
    );
    expect(created.value).toBe("FORMER");
  });

  it("closes the prior interval before minting a correction successor", async () => {
    mocks.findFirst.mockResolvedValue(row());
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) =>
        row({
          id: data.id,
          valueEncrypted: data.valueEncrypted,
          validFrom: data.validFrom,
          provenance: data.provenance,
        }),
    );
    const correctedAt = new Date("2026-07-28T12:00:00.000Z");

    const corrected = await correctHealthProfileFact(
      "user-1",
      "fact-1",
      "NEVER",
      correctedAt,
    );

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "fact-1",
        userId: "user-1",
        validUntil: null,
        supersededByRevisionId: null,
      },
      data: { validUntil: correctedAt },
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          kind: "SMOKING_STATUS",
          valueEncrypted: encoder.encode("encrypted:NEVER"),
          validFrom: correctedAt,
          provenance: "USER_CORRECTION",
        }),
      }),
    );
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "fact-1" },
      data: { supersededByRevisionId: corrected!.id },
    });
    expect(corrected).toMatchObject({
      value: "NEVER",
      validUntil: null,
      provenance: "USER_CORRECTION",
    });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        insightsCachedAt: null,
        insightsCachedText: null,
        insightsCachedLocale: null,
      },
    });
  });

  it("closes only the owner's current revision without deleting history", async () => {
    mocks.findFirst.mockResolvedValue(row());
    mocks.updateMany.mockResolvedValue({ count: 1 });
    const removedAt = new Date("2026-07-28T13:00:00.000Z");

    const removed = await removeHealthProfileFact(
      "user-1",
      "fact-1",
      removedAt,
    );

    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        id: "fact-1",
        userId: "user-1",
        validUntil: null,
        supersededByRevisionId: null,
      },
      select: { id: true, kind: true, validFrom: true },
    });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "fact-1",
        userId: "user-1",
        validUntil: null,
        supersededByRevisionId: null,
      },
      data: { validUntil: removedAt },
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(removed).toEqual({
      id: "fact-1",
      kind: "SMOKING_STATUS",
      removedAt: removedAt.toISOString(),
    });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        insightsCachedAt: null,
        insightsCachedText: null,
        insightsCachedLocale: null,
      },
    });
  });

  it("keeps the closed interval non-empty when the removal clock is not ahead", async () => {
    mocks.findFirst.mockResolvedValue(row());
    mocks.updateMany.mockResolvedValue({ count: 1 });
    const expectedClose = new Date(initial.getTime() + 1);

    const removed = await removeHealthProfileFact("user-1", "fact-1", initial);

    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { validUntil: expectedClose },
      }),
    );
    expect(removed?.removedAt).toBe(expectedClose.toISOString());
  });

  it("fails safely when the target is missing, stale, or belongs to another owner", async () => {
    mocks.findFirst.mockResolvedValue(null);

    await expect(
      removeHealthProfileFact("user-1", "not-current"),
    ).resolves.toBeNull();

    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("returns null when the current revision changes during removal", async () => {
    mocks.findFirst.mockResolvedValue(row());
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      removeHealthProfileFact("user-1", "fact-1"),
    ).resolves.toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("reads a closed revision as history while its current fact is absent", async () => {
    const removedAt = new Date("2026-07-28T13:00:00.000Z");
    mocks.findMany.mockResolvedValue([row({ validUntil: removedAt })]);

    const facts = await readHealthProfileFacts("user-1");

    expect(facts.current.SMOKING_STATUS).toBeNull();
    expect(facts.history).toEqual([
      expect.objectContaining({
        id: "fact-1",
        validUntil: removedAt.toISOString(),
        supersededByRevisionId: null,
      }),
    ]);
  });

  it("fails closed when ciphertext decrypts to a value outside its kind", () => {
    mocks.decrypt.mockReturnValue("ROTATING");
    expect(
      decryptHealthProfileFactValue(
        "SMOKING_STATUS",
        encoder.encode("ciphertext"),
      ),
    ).toEqual({ value: null, unreadable: true });
  });
});
