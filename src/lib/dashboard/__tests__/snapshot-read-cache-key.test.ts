/**
 * The snapshot read and the snapshot invalidator must agree on one key.
 *
 * `dashboardSnapshotCacheKey` is the declared source of truth, and the
 * invalidators sweep by its prefix. The read used to spell the same string
 * out by hand: identical today, silently divergent the moment either side is
 * edited, and the failure is invisible — the dashboard just keeps painting
 * the pre-write body until the entry ages out.
 *
 * So this asserts the agreement by effect rather than by text: warm the cell
 * through the real read, invalidate through the real invalidator, and require
 * that the next read rebuilds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/generated/prisma/client";

const buildDashboardSnapshot = vi.fn(async () => ({ tiles: {} }));
const resolveServerLocale = vi.fn(async () => "de");

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/dashboard/snapshot", () => ({
  buildDashboardSnapshot: (...args: unknown[]) =>
    buildDashboardSnapshot(...(args as [])),
}));
vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: (...args: unknown[]) =>
    resolveServerLocale(...(args as [])),
}));

const { readDashboardSnapshotCached } = await import("../snapshot-read");
const { caches, __resetAllCachesForTests } =
  await import("@/lib/cache/server-cache");
const {
  dashboardSnapshotCacheKey,
  invalidateUserDashboardSnapshot,
  invalidateUserMedications,
} = await import("@/lib/cache/invalidate");

const USER = { id: "user-key-guard", locale: "de" } as unknown as User;

beforeEach(() => {
  __resetAllCachesForTests();
  buildDashboardSnapshot.mockClear();
});

afterEach(() => {
  __resetAllCachesForTests();
});

describe("dashboard snapshot cache key", () => {
  it("writes the cell at the key the builder composes", async () => {
    const { body } = await readDashboardSnapshotCached(USER);

    // Exact key, not a prefix: `deleteByPrefix` would forgive a suffix change
    // on the read side and leave the drift undetected until a user saw it.
    expect(
      caches.analytics.get(`${dashboardSnapshotCacheKey(USER.id)}|de`),
    ).toBe(body);
  });

  it("serves the second read from the cell the first read wrote", async () => {
    await readDashboardSnapshotCached(USER);
    await readDashboardSnapshotCached(USER);

    expect(buildDashboardSnapshot).toHaveBeenCalledTimes(1);
  });

  it("rebuilds after the snapshot invalidator runs", async () => {
    await readDashboardSnapshotCached(USER);
    invalidateUserDashboardSnapshot(USER.id);
    await readDashboardSnapshotCached(USER);

    expect(buildDashboardSnapshot).toHaveBeenCalledTimes(2);
  });

  it("rebuilds after an interactive medication write", async () => {
    // The path behind the reported symptom: a dose is recorded, the intake
    // route evicts, and the very next dashboard read must not be the old body.
    await readDashboardSnapshotCached(USER);
    invalidateUserMedications(USER.id, { evict: true });
    await readDashboardSnapshotCached(USER);

    expect(buildDashboardSnapshot).toHaveBeenCalledTimes(2);
  });
});
