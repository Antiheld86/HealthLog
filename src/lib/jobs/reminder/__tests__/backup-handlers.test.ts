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
// the stored bytes can be read back as JSON. The size error is the real class
// so the handler's `instanceof` arm is the one that runs.
vi.mock("@/lib/export/backup-blob", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/export/backup-blob")
  >("@/lib/export/backup-blob");
  return {
    BackupBlobTooLargeError: actual.BackupBlobTooLargeError,
    packBackupBlobStreaming: async (
      produce: (write: (chunk: string) => Promise<void>) => Promise<void>,
    ) => {
      let out = "";
      await produce(async (chunk) => {
        out += chunk;
      });
      return mocks.packBlob(out);
    },
  };
});

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

import { BackupBlobTooLargeError } from "@/lib/export/backup-blob";

import { handleDataBackup } from "../backup-handlers";

const documentCiphertext = Buffer.from([1, 2, 3, 4]).toString("base64");

function buildPrismaMock(
  users: Array<{ id: string; username: string }> = [
    { id: "user-dr", username: "backup-owner" },
  ],
) {
  return {
    user: { findMany: vi.fn().mockResolvedValue(users) },
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

/**
 * What the pass says about itself when it protected nobody.
 *
 * The weekly job used to report `ok: true` with `backed: 0` — a completed
 * pg-boss job, an untouched failing-queue panel, and a backups page listing
 * copies from six weeks earlier with perfectly ordinary timestamps. Every
 * surface an operator could look at agreed that a pass which wrote nothing
 * had gone fine.
 */
describe("handleDataBackup outcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsert.mockResolvedValue({});
    mocks.buildFullBackupPayload.mockResolvedValue({
      payload: { schemaVersion: "1", userId: "user-dr" },
      counts: {},
    });
  });

  it("fails the run when not one account got a copy", async () => {
    mocks.getWorkerPrisma.mockReturnValue(buildPrismaMock());
    mocks.upsert.mockRejectedValue(new Error("write failed"));

    const outcome = await handleDataBackup([]);

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({
      ok: false,
      reason: "no account could be backed up",
      did: { backed: 0, total: 1, users_failed: 1, records_oversized: 0 },
    });
  });

  it("counts an oversized record as the reason it could not", async () => {
    mocks.getWorkerPrisma.mockReturnValue(buildPrismaMock());
    mocks.upsert.mockRejectedValue(new BackupBlobTooLargeError(9_000, 4_096));

    const outcome = await handleDataBackup([]);

    expect(outcome).toMatchObject({
      ok: false,
      did: { backed: 0, users_failed: 1, records_oversized: 1 },
    });
  });

  it("still passes when one account failed and another was written", async () => {
    // The fan-out rule: a pass is judged on the pass. Failing the queue over
    // one account's record would re-run the whole cohort on every retry, and
    // that account's own copy ages on the backups page either way.
    mocks.getWorkerPrisma.mockReturnValue(
      buildPrismaMock([
        { id: "user-a", username: "a" },
        { id: "user-b", username: "b" },
      ]),
    );
    mocks.upsert
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce({});

    const outcome = await handleDataBackup([]);

    expect(outcome).toMatchObject({
      ok: true,
      did: { backed: 1, total: 2, users_failed: 1 },
    });
  });

  it("passes on an instance with no accounts at all", async () => {
    mocks.getWorkerPrisma.mockReturnValue(buildPrismaMock([]));

    const outcome = await handleDataBackup([]);

    expect(outcome).toMatchObject({ ok: true, did: { backed: 0, total: 0 } });
  });
});
