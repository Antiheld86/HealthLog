/**
 * RED real-PostgreSQL contract for the nullable
 * GoogleHealthConnection.syncProgress current-run envelope.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

type ProgressModule = {
  startGoogleHealthSyncProgress: (
    userId: string,
    now?: Date,
  ) => Promise<{ runId: string }>;
  updateGoogleHealthSyncProgress: (
    userId: string,
    runId: string,
    update: Record<string, unknown>,
    now?: Date,
  ) => Promise<boolean>;
  readGoogleHealthSyncProgress: (
    userId: string,
    now?: Date,
  ) => Promise<Record<string, unknown> | null>;
};

async function progressModule(): Promise<ProgressModule> {
  return (await import("@/lib/google-health/sync-progress")) as unknown as ProgressModule;
}

async function seedConnection(userId: string): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: userId,
      username: userId,
      email: `${userId}@example.test`,
    },
  });
  await prisma.googleHealthConnection.create({
    data: {
      userId,
      googleUserId: `google-${userId}`,
      accessToken: "encrypted-access",
      refreshToken: "encrypted-refresh",
      tokenExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
    },
  });
}

async function rawProgress(
  userId: string,
): Promise<Record<string, unknown> | null> {
  const prisma = getPrismaClient();
  const rows = await prisma.$queryRawUnsafe<Array<{ sync_progress: unknown }>>(
    `SELECT sync_progress FROM google_health_connections WHERE user_id = $1`,
    userId,
  );
  return (rows[0]?.sync_progress as Record<string, unknown> | null) ?? null;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("Google Health current-run progress (real Postgres)", () => {
  it("keeps one owner-scoped current run and rejects delayed older writers", async () => {
    await seedConnection("progress-owner");
    await seedConnection("progress-other");
    const progress = await progressModule();

    const older = await progress.startGoogleHealthSyncProgress(
      "progress-owner",
      new Date("2026-07-29T10:00:00.000Z"),
    );
    const newer = await progress.startGoogleHealthSyncProgress(
      "progress-owner",
      new Date("2026-07-29T10:01:00.000Z"),
    );

    expect(older.runId).not.toBe(newer.runId);
    await expect(
      progress.updateGoogleHealthSyncProgress("progress-owner", older.runId, {
        state: "failed",
      }),
    ).resolves.toBe(false);
    await expect(
      progress.updateGoogleHealthSyncProgress("progress-owner", newer.runId, {
        state: "complete",
        written: 3,
      }),
    ).resolves.toBe(true);

    expect(await rawProgress("progress-owner")).toMatchObject({
      runId: newer.runId,
      state: "complete",
    });
    expect(
      await progress.readGoogleHealthSyncProgress("progress-other"),
    ).toBeNull();
  });

  it("allows only one concurrent terminal writer to own the retained run", async () => {
    await seedConnection("progress-race");
    const progress = await progressModule();
    const current =
      await progress.startGoogleHealthSyncProgress("progress-race");

    const results = await Promise.all([
      progress.updateGoogleHealthSyncProgress("progress-race", current.runId, {
        state: "complete",
        written: 4,
      }),
      (async () => {
        await progress.startGoogleHealthSyncProgress("progress-race");
        return progress.updateGoogleHealthSyncProgress(
          "progress-race",
          current.runId,
          { state: "failed" },
        );
      })(),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await rawProgress("progress-race"))?.runId).not.toBe(current.runId);
  });

  it("persists bounded keys/cardinality without secrets or per-sample facts", async () => {
    await seedConnection("progress-private");
    const progress = await progressModule();
    const run =
      await progress.startGoogleHealthSyncProgress("progress-private");
    await progress.updateGoogleHealthSyncProgress(
      "progress-private",
      run.runId,
      {
        state: "partial",
        accessToken: "raw-access-token",
        refreshToken: "raw-refresh-token",
        url: "https://provider.invalid/private",
        rawError: "provider response body",
        healthValue: 181,
        samples: Array.from({ length: 100 }, (_, bpm) => ({ bpm })),
      },
    );

    const stored = await rawProgress("progress-private");
    expect(Object.keys(stored ?? {}).sort()).toEqual(
      expect.arrayContaining([
        "runId",
        "state",
        "startedAt",
        "updatedAt",
        "resources",
      ]),
    );
    expect((stored?.resources as unknown[]).length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(stored)).not.toMatch(
      /raw-access-token|raw-refresh-token|provider\\.invalid|provider response body|healthValue|samples|bpm/,
    );
  });

  it("materializes stale in-progress state as interrupted", async () => {
    await seedConnection("progress-stale");
    const progress = await progressModule();
    await progress.startGoogleHealthSyncProgress(
      "progress-stale",
      new Date("2026-07-29T08:00:00.000Z"),
    );

    await expect(
      progress.readGoogleHealthSyncProgress(
        "progress-stale",
        new Date("2026-07-29T10:00:00.000Z"),
      ),
    ).resolves.toMatchObject({
      state: "interrupted",
      terminalAt: expect.any(String),
    });
  });
});
