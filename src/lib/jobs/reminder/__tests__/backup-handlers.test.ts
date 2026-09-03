import { Buffer } from "node:buffer";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildFullBackupPayload: vi.fn(),
  packBlob: vi.fn((value: string) => value),
  getWorkerPrisma: vi.fn(),
  upsert: vi.fn(),
}));

// Only the payload builder is stubbed. The REAL streaming writer runs on top
// of it, so this file keeps stubbing and asserting the PAYLOAD — which is what
// it is about — while the framing that turns it into stored bytes is the
// framing the job actually uses. `isDeferredRows` rides along because the
// writer asks it about every section; nothing here defers.
vi.mock("@/lib/export/full-backup-payload", () => ({
  buildFullBackupPayload: mocks.buildFullBackupPayload,
  isDeferredRows: () => false,
}));

// The envelope is exercised end-to-end in
// `src/lib/export/__tests__/backup-blob.test.ts`; here it stays transparent so
// the stored bytes can be read back as JSON.
vi.mock("@/lib/export/backup-blob", () => ({
  packBackupBlobStreaming: async (
    produce: (write: (chunk: string) => Promise<void>) => Promise<void>,
  ) => {
    let out = "";
    await produce(async (chunk) => {
      out += chunk;
    });
    return mocks.packBlob(out);
  },
}));

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: vi.fn(
    async (_name: string, run: (event: object) => Promise<void>) =>
      run({
        addMeta: vi.fn(),
        addWarning: vi.fn(),
        setBackground: vi.fn(),
        setError: vi.fn(),
      }),
  ),
}));

vi.mock("../shared", () => ({
  getWorkerPrisma: mocks.getWorkerPrisma,
}));

import { handleDataBackup } from "../backup-handlers";

const documentCiphertext = Buffer.from([1, 2, 3, 4]).toString("base64");

function buildPrismaMock() {
  return {
    user: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: "user-dr", username: "backup-owner" }]),
    },
    dataBackup: { upsert: mocks.upsert },
  };
}

describe("handleDataBackup canonical DR payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkerPrisma.mockReturnValue(buildPrismaMock());
    mocks.upsert.mockResolvedValue({});
    mocks.buildFullBackupPayload.mockResolvedValue({
      payload: {
        schemaVersion: "1",
        exportedAt: "2026-07-20T00:00:00.000Z",
        userId: "user-dr",
        moodEntries: [
          {
            id: "mood-dr",
            externalId: "mood-external-dr",
            factors: [{ key: "sleep_quality", rating: 5 }],
          },
        ],
        documents: [
          {
            id: "document-dr",
            contentEncrypted: documentCiphertext,
            contentCodec: "binary2",
          },
        ],
      },
      counts: {},
    });
  });

  it("serializes the shared canonical disaster-recovery payload", async () => {
    await handleDataBackup([]);

    const prisma = mocks.getWorkerPrisma.mock.results[0]!.value;
    expect(mocks.buildFullBackupPayload).toHaveBeenCalledWith(
      prisma,
      "user-dr",
      // `deferBulk` is the writer's own ask: it declares the unbounded tables
      // rather than reading them, and pulls their rows through itself.
      expect.objectContaining({
        purpose: "disaster-recovery",
        deferBulk: true,
      }),
    );
    expect(mocks.upsert).toHaveBeenCalledOnce();
    const encrypted = mocks.upsert.mock.calls[0]![0].create.data as string;
    const payload = JSON.parse(encrypted) as {
      moodEntries: Array<{
        id: string;
        externalId: string;
        factors: Array<{ key: string; rating: number }>;
      }>;
      documents: Array<{ contentEncrypted: string; contentCodec: string }>;
    };
    expect(payload.moodEntries).toEqual([
      expect.objectContaining({
        id: "mood-dr",
        externalId: "mood-external-dr",
        factors: [{ key: "sleep_quality", rating: 5 }],
      }),
    ]);
    expect(payload.documents).toEqual([
      expect.objectContaining({
        contentEncrypted: documentCiphertext,
        contentCodec: "binary2",
      }),
    ]);
  });
});
