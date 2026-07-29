/**
 * RED unit contract for the Plan 21 current-run store.
 *
 * These names deliberately define the small storage seam Plan 21 implements:
 * one owner-scoped create, guarded update, and stale-aware read. They are not
 * provider or pagination policy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type UpdateManyArg = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    googleHealthConnection: {
      findUnique: vi.fn(),
      update: vi.fn(async ({ data }) => data),
      updateMany: vi.fn(async (_args: UpdateManyArg) => ({ count: 1 })),
    },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

type ProgressModule = {
  startGoogleHealthSyncProgress: (
    userId: string,
    now?: Date,
  ) => Promise<{ runId: string; state: string; resources: unknown[] }>;
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
  return (await import("../sync-progress")) as unknown as ProgressModule;
}

function firstUpdateManyArg(): UpdateManyArg {
  const arg =
    prismaMock.googleHealthConnection.updateMany.mock.calls.at(0)?.[0];
  if (!arg) throw new Error("Expected one guarded progress update");
  return arg;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.googleHealthConnection.update.mockImplementation(
    async ({ data }) => data,
  );
  prismaMock.googleHealthConnection.updateMany.mockResolvedValue({ count: 1 });
});

describe("Google Health current-run progress", () => {
  it("starts unpredictable single-run envelopes with bounded fixed resources", async () => {
    const progress = await progressModule();
    const now = new Date("2026-07-29T10:00:00.000Z");

    const first = await progress.startGoogleHealthSyncProgress("owner", now);
    const second = await progress.startGoogleHealthSyncProgress("owner", now);

    expect(first.runId).not.toBe(second.runId);
    expect(first.runId.length).toBeGreaterThanOrEqual(20);
    expect(first.state).toBe("in_progress");
    expect(first.resources.length).toBeGreaterThan(0);
    expect(first.resources.length).toBeLessThanOrEqual(16);

    const persisted =
      prismaMock.googleHealthConnection.update.mock.calls.at(-1)?.[0];
    expect(persisted.where).toEqual({ userId: "owner" });
    expect(Object.keys(persisted.data.syncProgress).sort()).toEqual(
      expect.arrayContaining([
        "runId",
        "state",
        "startedAt",
        "updatedAt",
        "resources",
      ]),
    );
  });

  it("guards every update by both owner and current runId", async () => {
    const progress = await progressModule();
    await expect(
      progress.updateGoogleHealthSyncProgress(
        "owner",
        "run-current",
        { state: "complete", written: 4 },
        new Date("2026-07-29T10:01:00.000Z"),
      ),
    ).resolves.toBe(true);

    const updateArg = firstUpdateManyArg();
    const serializedGuard = JSON.stringify(updateArg.where);
    expect(serializedGuard).toContain("owner");
    expect(serializedGuard).toContain("run-current");

    prismaMock.googleHealthConnection.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    await expect(
      progress.updateGoogleHealthSyncProgress("owner", "run-stale", {
        state: "failed",
      }),
    ).resolves.toBe(false);
  });

  it("turns stale in-progress reads into an interrupted terminal", async () => {
    const progress = await progressModule();
    prismaMock.googleHealthConnection.findUnique.mockResolvedValue({
      syncProgress: {
        runId: "run-stale",
        state: "in_progress",
        startedAt: "2026-07-29T08:00:00.000Z",
        updatedAt: "2026-07-29T08:00:00.000Z",
        resources: [],
      },
    });

    const read = await progress.readGoogleHealthSyncProgress(
      "owner",
      new Date("2026-07-29T10:00:00.000Z"),
    );

    expect(read).toMatchObject({
      runId: "run-stale",
      state: "interrupted",
      terminalAt: expect.any(String),
    });
    expect(JSON.stringify(firstUpdateManyArg().where)).toContain("run-stale");
  });

  it("drops secret, URL, raw-error, health-value, and sample-shaped fields", async () => {
    const progress = await progressModule();
    await progress.updateGoogleHealthSyncProgress("owner", "run-current", {
      state: "partial",
      accessToken: "secret-token",
      url: "https://provider.invalid/capability",
      rawError: "provider body",
      healthValue: 123,
      samples: [{ bpm: 180 }],
      resources: Array.from({ length: 100 }, (_, index) => ({
        resource: `resource-${index}`,
      })),
    });

    const persisted = JSON.stringify(firstUpdateManyArg().data);
    expect(persisted).not.toMatch(
      /secret-token|provider\\.invalid|provider body|healthValue|bpm|samples/,
    );
  });
});
