/**
 * Off-host copies leave the bucket with the account.
 *
 * The bucket is a map behind the same `S3Like` boundary the real client
 * implements; the request ledger is an in-memory table. Mutations that must
 * turn this red: drop the `deleteObject` call (the objects stay), remove the
 * request on failure too (the refusal case loses the request), or match on the
 * key prefix instead of the full account pattern (another account's objects,
 * or the health-check probe, go too).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));

import { auditLog } from "@/lib/auth/audit";
import { processOffhostPurges, requestOffhostPurge } from "../offhost-purge";

interface Row {
  id: string;
  subjectId: string;
  reason: string;
  requestedAt: Date;
  attempts: number;
  lastAttemptAt: Date | null;
  lastFailure: string | null;
}

function makeLedger(existingUsers: string[] = []) {
  const rows: Row[] = [];
  let seq = 0;
  const prisma = {
    offhostPurgeRequest: {
      create: vi.fn(
        async ({ data }: { data: { subjectId: string; reason: string } }) => {
          const row: Row = {
            id: `r${++seq}`,
            subjectId: data.subjectId,
            reason: data.reason,
            requestedAt: new Date(Date.now() + seq),
            attempts: 0,
            lastAttemptAt: null,
            lastFailure: null,
          };
          rows.push(row);
          return { id: row.id };
        },
      ),
      findMany: vi.fn(async () =>
        [...rows].sort((a, b) => +a.requestedAt - +b.requestedAt),
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows.splice(
          rows.findIndex((r) => r.id === where.id),
          1,
        );
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: { in: string[] } };
          data: { lastAttemptAt: Date; lastFailure: string };
        }) => {
          for (const row of rows) {
            if (!where.id.in.includes(row.id)) continue;
            row.attempts += 1;
            row.lastAttemptAt = data.lastAttemptAt;
            row.lastFailure = data.lastFailure;
          }
        },
      ),
    },
    user: {
      count: vi.fn(async ({ where }: { where: { id: string } }) =>
        existingUsers.includes(where.id) ? 1 : 0,
      ),
    },
  };
  return { rows, prisma };
}

function makeBucket(keys: string[]) {
  const store = new Set(keys);
  return {
    store,
    putObject: vi.fn(),
    putStream: vi.fn(),
    getObject: vi.fn(),
    headObject: vi.fn(),
    listObjects: vi.fn(async (prefix: string) =>
      [...store].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
    ),
    deleteObject: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

const BUCKET = [
  "2026-09-01/user-gone.json.enc",
  "2026-09-02/user-gone.json.enc",
  "2026-09-02/user-gone2.json.enc",
  "2026-09-02/user-stays.json.enc",
  "_healthcheck/1.bin",
];

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.stubEnv("BACKUP_S3_ENDPOINT", "https://r2.example");
  vi.stubEnv("BACKUP_S3_BUCKET", "hl-backups");
  vi.stubEnv("BACKUP_S3_ACCESS_KEY", "AKIA");
  vi.stubEnv("BACKUP_S3_SECRET_KEY", "secret");
  vi.stubEnv("BACKUP_ENCRYPTION_KEY", "ab".repeat(32));
});

describe("off-host purge", () => {
  it("deletes every copy of the account, and nothing else", async () => {
    const { rows, prisma } = makeLedger();
    await requestOffhostPurge(prisma as never, "gone", "account_deleted");
    const bucket = makeBucket(BUCKET);

    const report = await processOffhostPurges(prisma as never, bucket);

    expect([...bucket.store].sort()).toEqual([
      "2026-09-02/user-gone2.json.enc",
      "2026-09-02/user-stays.json.enc",
      "_healthcheck/1.bin",
    ]);
    expect(report).toMatchObject({
      completed: 1,
      failed: 0,
      objectsDeleted: 2,
    });
    expect(rows).toHaveLength(0);
    // The account is gone, and so is its audit trail: the receipt carries the
    // reason and the count, not the account.
    expect(auditLog).toHaveBeenCalledWith(
      "offhost.backup.purged",
      expect.objectContaining({
        userId: null,
        details: expect.objectContaining({
          reason: "account_deleted",
          objectsDeleted: 2,
        }),
      }),
    );
  });

  it("keeps the request, with the bucket's answer, when a delete is refused", async () => {
    const { rows, prisma } = makeLedger(["gone"]);
    await requestOffhostPurge(prisma as never, "gone", "data_wiped");
    const bucket = makeBucket(BUCKET);
    bucket.deleteObject.mockRejectedValueOnce(new Error("AccessDenied"));

    const report = await processOffhostPurges(prisma as never, bucket);

    expect(report).toMatchObject({ completed: 0, failed: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 1, lastFailure: "AccessDenied" });

    // The next run finishes it, and the account that still exists keeps the
    // receipt.
    const again = await processOffhostPurges(prisma as never, bucket);
    expect(again.completed).toBe(1);
    expect(rows).toHaveLength(0);
    expect(auditLog).toHaveBeenCalledWith(
      "offhost.backup.purged",
      expect.objectContaining({ userId: "gone" }),
    );
  });

  it("records nothing on a host without off-host backup", async () => {
    vi.stubEnv("BACKUP_S3_ENDPOINT", "");
    const { rows, prisma } = makeLedger();
    expect(
      await requestOffhostPurge(prisma as never, "gone", "account_deleted"),
    ).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("does not list the bucket when nothing is pending", async () => {
    const { prisma } = makeLedger();
    const bucket = makeBucket(BUCKET);
    await processOffhostPurges(prisma as never, bucket);
    expect(bucket.listObjects).not.toHaveBeenCalled();
  });
});
