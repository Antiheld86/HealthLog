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
  const walked = new Map<string, Date>();
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
          data: {
            lastAttemptAt: Date;
            lastFailure: string | null;
            attempts?: unknown;
          };
        }) => {
          for (const row of rows) {
            if (!where.id.in.includes(row.id)) continue;
            if (data.attempts) row.attempts += 1;
            row.lastAttemptAt = data.lastAttemptAt;
            row.lastFailure = data.lastFailure;
          }
        },
      ),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        existingUsers
          .filter((id) => where.id.in.includes(id))
          .map((id) => ({ id })),
      ),
    },
    // When the nightly run last walked each account.
    offhostBackupState: {
      findMany: vi.fn(async () =>
        [...walked].map(([userId, lastAttemptAt]) => ({
          userId,
          lastAttemptAt,
        })),
      ),
    },
  };
  return { rows, prisma, walked };
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
    const { rows, prisma, walked } = makeLedger(["gone"]);
    await requestOffhostPurge(prisma as never, "gone", "data_wiped");
    const bucket = makeBucket(BUCKET);
    bucket.deleteObject.mockRejectedValueOnce(new Error("AccessDenied"));

    const report = await processOffhostPurges(prisma as never, bucket);

    expect(report).toMatchObject({ completed: 0, failed: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 1, lastFailure: "AccessDenied" });

    // The next run finishes it once a nightly run has walked the account
    // since the wipe, and the account that still exists keeps the receipt.
    walked.set("gone", new Date(Date.now() + 60_000));
    const again = await processOffhostPurges(prisma as never, bucket);
    expect(again.completed).toBe(1);
    expect(rows).toHaveLength(0);
    expect(auditLog).toHaveBeenCalledWith(
      "offhost.backup.purged",
      expect.objectContaining({ userId: "gone" }),
    );
  });

  it("keeps a wipe's request until a nightly run has walked the account since", async () => {
    // The upload in flight during the wipe reads the request to throw its
    // pre-wipe copy away; removing the request on the first purge let that
    // copy land afterwards and stay.
    const { rows, prisma, walked } = makeLedger(["gone"]);
    walked.set("gone", new Date(Date.now() - 3_600_000));
    await requestOffhostPurge(prisma as never, "gone", "data_wiped");
    const wipeDay = rows[0]!.requestedAt.toISOString().slice(0, 10);
    const bucket = makeBucket(BUCKET);

    const first = await processOffhostPurges(prisma as never, bucket);
    expect(first).toMatchObject({ completed: 0, awaitingRun: 1, failed: 0 });
    expect(first.objectsDeleted).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 0, lastFailure: null });
    expect(auditLog).toHaveBeenCalledTimes(1);

    // A pass before the run reached the account keeps waiting and writes no
    // second receipt.
    const waiting = await processOffhostPurges(prisma as never, bucket);
    expect(waiting).toMatchObject({ completed: 0, awaitingRun: 1 });
    expect(auditLog).toHaveBeenCalledTimes(1);

    // The next night walks the account and writes the copy of what it holds
    // after the wipe. The purge then closes the request and leaves that copy.
    const nextDay = new Date(Date.parse(`${wipeDay}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    bucket.store.add(`${nextDay}/user-gone.json.enc`);
    walked.set("gone", new Date(Date.now() + 60_000));
    const done = await processOffhostPurges(prisma as never, bucket);
    expect(done).toMatchObject({ completed: 1, awaitingRun: 0 });
    expect(rows).toHaveLength(0);
    expect(bucket.store.has(`${nextDay}/user-gone.json.enc`)).toBe(true);
  });

  it("removes every copy of an account deleted after a wipe", async () => {
    const { rows, prisma } = makeLedger();
    await requestOffhostPurge(prisma as never, "gone", "data_wiped");
    await requestOffhostPurge(prisma as never, "gone", "account_deleted");
    const bucket = makeBucket([...BUCKET, "2999-01-01/user-gone.json.enc"]);

    const report = await processOffhostPurges(prisma as never, bucket);
    expect(report).toMatchObject({ completed: 2, awaitingRun: 0 });
    expect(rows).toHaveLength(0);
    expect([...bucket.store].some((k) => k.includes("user-gone."))).toBe(false);
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
