/**
 * v1.4.25 W17b — Withings activity-sync unit tests.
 *
 * Coverage focuses on the per-page response shape, field mapping, and
 * the writer's idempotency hook. The end-to-end DB path is covered by
 * the integration suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => {
  // v1.20.2 F3 — the write path batches: one `findMany` resolves the
  // overwrite-vs-insert decision for the whole sync, `createMany` lands
  // every fresh slot, and changed-value overwrites run inside a
  // `$transaction([...update])`. The mock `$transaction` awaits the array
  // of update promises so the per-row `update` mocks still fire and the
  // call counts assert the batched shape.
  const measurement = {
    findMany: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
  };
  return {
    prisma: {
      measurement,
      withingsConnection: {
        findUnique: vi.fn(),
      },
      $transaction: vi.fn((ops: unknown) =>
        Array.isArray(ops) ? Promise.all(ops) : Promise.resolve(),
      ),
    },
  };
});

vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn().mockResolvedValue(false),
  parkIntegrationAtReauth: vi.fn(),
  recordSyncFailure: vi.fn(),
  recordSyncSuccess: vi.fn(),
}));

vi.mock("../sync", async () => {
  const actual = await vi.importActual<typeof import("../sync")>("../sync");
  return {
    ...actual,
    getValidToken: vi.fn(async () => ({
      accessToken: "token",
      connection: { id: "conn-1", withingsUserId: "wu-1" },
    })),
  };
});

vi.mock("@/lib/logging/context", () => ({
  getEvent: vi.fn(() => ({
    addExternalCall: vi.fn(),
    addWarning: vi.fn(),
  })),
}));

// v1.4.39.1 — the sync now hands its touched (type, day) keys to the
// measurement rollup writer so the dashboard chart's `source=rollup`
// fast-path sees the new buckets. The mock collects the call args so
// the regression test below can assert the hook fired.
vi.mock("@/lib/rollups/measurement-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  return {
    ...actual,
    recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
  };
});

import { prisma } from "@/lib/db";
import {
  parkIntegrationAtReauth,
  recordSyncFailure,
  recordSyncSuccess,
} from "@/lib/integrations/status";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";

import { fetchWithingsActivity, syncUserActivity } from "../sync-activity";

interface FakeActivity {
  date: string;
  steps?: number;
  distance?: number;
  calories?: number;
}

function installFetchMock(entries: FakeActivity[]) {
  const fetchMock = vi.fn(async () => ({
    status: 200,
    json: async () => ({
      status: 0,
      body: {
        activities: entries,
        more: false,
        offset: 0,
      },
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.resetAllMocks();
  // v1.4.26 — every syncUserActivity call now reads the connection's
  // scope to short-circuit legacy `user.metrics`-only connections.
  // Default-mock to "scope is fine" so the existing field-mapping +
  // idempotency tests stay focused on the write path. The scope-skip
  // case has its own dedicated tests below.
  vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
    scope: "user.metrics,user.activity",
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWithingsActivity", () => {
  it("POSTs getactivity with steps + distance + calories in data_fields", async () => {
    const fetchMock = installFetchMock([]);
    await fetchWithingsActivity("token", "2026-05-01", "2026-05-12");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://wbsapi.withings.net/v2/measure");
    const body = String(init.body);
    expect(body).toContain("action=getactivity");
    expect(body).toContain("startdateymd=2026-05-01");
    expect(body).toContain("enddateymd=2026-05-12");
    expect(body).toContain("data_fields=steps%2Cdistance%2Ccalories");
  });

  it("returns one entry per day from the response", async () => {
    installFetchMock([
      { date: "2026-05-10", steps: 8420, distance: 6720, calories: 412 },
      { date: "2026-05-11", steps: 5012, distance: 3950, calories: 245 },
    ]);
    const entries = await fetchWithingsActivity(
      "token",
      "2026-05-10",
      "2026-05-11",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].steps).toBe(8420);
    expect(entries[1].date).toBe("2026-05-11");
  });

  it("throws when Withings returns a non-zero status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 293, error: "insufficient scope" }),
      })),
    );
    await expect(
      fetchWithingsActivity("token", "2026-05-10", "2026-05-11"),
    ).rejects.toThrow(/Withings activity error: 293/);
  });
});

/**
 * v1.20.2 F3 — helper: pull the flat `data[]` the batched `createMany`
 * received (the writer always passes a single call with every fresh
 * slot). Returns `[]` when `createMany` never fired.
 */
function createManyRows(): Array<Record<string, unknown>> {
  const calls = vi.mocked(prisma.measurement.createMany).mock.calls;
  if (calls.length === 0) return [];
  return (calls[0][0] as { data: Array<Record<string, unknown>> }).data;
}

describe("syncUserActivity — field mapping + idempotency", () => {
  it("writes one row per (date, metric) the first time a day shows up", async () => {
    installFetchMock([
      { date: "2026-05-12", steps: 8420, distance: 6720, calories: 412 },
    ]);
    // No existing slot rows → every planned row is an insert.
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.createMany).mockResolvedValue({
      count: 3,
    } as never);

    const imported = await syncUserActivity("user-1");

    expect(imported).toBe(3);
    // v1.20.2 F3 — one batched insert carrying all three metric rows.
    expect(prisma.measurement.createMany).toHaveBeenCalledTimes(1);

    const types = createManyRows().map((r) => r.type as string);
    expect(types.sort()).toEqual([
      "ACTIVE_ENERGY_BURNED",
      "ACTIVITY_STEPS",
      "WALKING_RUNNING_DISTANCE",
    ]);
  });

  it("updates instead of inserting when the same (date, metric) already exists with a different value", async () => {
    installFetchMock([
      { date: "2026-05-12", steps: 9001, distance: 7000, calories: 450 },
    ]);
    const measuredAt = new Date("2026-05-12T12:00:00.000Z");
    // Each slot already holds a row with a DIFFERENT value → all three
    // overwrite (the value moved). Keyed by the same four columns the
    // batched read matches on.
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        id: "row-steps",
        type: "ACTIVITY_STEPS",
        measuredAt,
        value: 1,
        deletedAt: null,
      },
      {
        id: "row-distance",
        type: "WALKING_RUNNING_DISTANCE",
        measuredAt,
        value: 1,
        deletedAt: null,
      },
      {
        id: "row-calories",
        type: "ACTIVE_ENERGY_BURNED",
        measuredAt,
        value: 1,
        deletedAt: null,
      },
    ] as never);
    vi.mocked(prisma.measurement.update).mockResolvedValue({} as never);

    const imported = await syncUserActivity("user-1");

    expect(imported).toBe(3);
    expect(prisma.measurement.createMany).not.toHaveBeenCalled();
    // One batched `$transaction` carrying three per-row updates.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.measurement.update).toHaveBeenCalledTimes(3);
  });

  it("skips the write entirely when an existing slot already holds the same value (idempotent re-sync)", async () => {
    installFetchMock([{ date: "2026-05-12", steps: 8420 }]);
    const measuredAt = new Date("2026-05-12T12:00:00.000Z");
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        id: "row-steps",
        type: "ACTIVITY_STEPS",
        measuredAt,
        value: 8420,
        deletedAt: null,
      },
    ] as never);

    const imported = await syncUserActivity("user-1");

    // The slot is still "touched" (rollup re-fold + imported count), but
    // no value moved so neither the insert nor the update path runs.
    expect(imported).toBe(1);
    expect(prisma.measurement.createMany).not.toHaveBeenCalled();
    expect(prisma.measurement.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("resurrects a tombstoned slot even when the value is unchanged (deletedAt: null)", async () => {
    installFetchMock([{ date: "2026-05-12", steps: 8420 }]);
    const measuredAt = new Date("2026-05-12T12:00:00.000Z");
    // Same value, but the row is tombstoned: the write is what resurrects
    // it — Withings owns the row, so a re-fetched day brings it back.
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        id: "row-steps",
        type: "ACTIVITY_STEPS",
        measuredAt,
        value: 8420,
        deletedAt: new Date("2026-05-13T00:00:00.000Z"),
      },
    ] as never);
    vi.mocked(prisma.measurement.update).mockResolvedValue({} as never);

    const imported = await syncUserActivity("user-1");

    expect(imported).toBe(1);
    expect(prisma.measurement.createMany).not.toHaveBeenCalled();
    expect(prisma.measurement.update).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.measurement.update).mock.calls[0][0] as {
      data: { value: number; deletedAt: Date | null };
    };
    expect(arg.data.value).toBe(8420);
    expect(arg.data.deletedAt).toBeNull();
  });

  it("anchors measuredAt at noon UTC so the instant lands inside the local day for every supported tz", async () => {
    installFetchMock([{ date: "2026-05-12", steps: 1000 }]);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.createMany).mockResolvedValue({
      count: 1,
    } as never);

    await syncUserActivity("user-1");

    const measuredAt = createManyRows()[0].measuredAt as Date;
    expect(measuredAt.toISOString()).toBe("2026-05-12T12:00:00.000Z");

    // Regression: anchoring at noon UTC keeps the row inside the
    // calendar day every user reads it in. Bucketing the same instant
    // via `Intl.DateTimeFormat` across the canonical Withings user
    // span — Honolulu (UTC-10), Los Angeles (UTC-7/-8), Berlin
    // (UTC+1/+2) and Tokyo (UTC+9) — must all return "2026-05-12".
    // Anchoring at end-of-day UTC (the v1.4.25 W17b shape) shifted
    // Tokyo by +1 day; anchoring at midnight UTC would shift LA by -1.
    // Noon UTC is the only choice that holds across the practical
    // [-11, +12) range.
    const bucket = (tz: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(measuredAt);
    expect(bucket("Pacific/Honolulu")).toBe("2026-05-12");
    expect(bucket("America/Los_Angeles")).toBe("2026-05-12");
    expect(bucket("Europe/Berlin")).toBe("2026-05-12");
    expect(bucket("Asia/Tokyo")).toBe("2026-05-12");
  });

  it("skips missing fields without writing zero rows or throwing", async () => {
    // `distance` absent — Withings drops the field rather than emitting 0
    // when there's no GPS. Steps + calories still write.
    installFetchMock([{ date: "2026-05-12", steps: 8000, calories: 380 }]);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.createMany).mockResolvedValue({
      count: 2,
    } as never);

    const imported = await syncUserActivity("user-1");

    expect(imported).toBe(2);
    const types = createManyRows().map((r) => r.type as string);
    expect(types).not.toContain("WALKING_RUNNING_DISTANCE");
  });

  it("ingests a 0-step rest day rather than dropping it", async () => {
    // Withings reports 0 steps for a day a user spent in bed — that's
    // a valid datapoint, not a missing one. The mapper must not skip
    // it (which would let the prior day's value erroneously "stick").
    installFetchMock([
      { date: "2026-05-12", steps: 0, distance: 0, calories: 0 },
    ]);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.createMany).mockResolvedValue({
      count: 3,
    } as never);

    const imported = await syncUserActivity("user-1");
    expect(imported).toBe(3);
  });

  it("calls recordSyncSuccess after a clean round-trip", async () => {
    installFetchMock([{ date: "2026-05-12", steps: 1000 }]);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.createMany).mockResolvedValue({
      count: 1,
    } as never);

    await syncUserActivity("user-1");
    expect(recordSyncSuccess).toHaveBeenCalledWith("user-1", "withings");
  });

  it("W-2 — records a transient failure and refuses the success stamp when the batch write throws", async () => {
    // A swallowed batch-write used to fall through to recordSyncSuccess: green
    // pill over lost data, and a PERSISTENT write bug green forever. The write
    // failure now records a transient failure and the success stamp is skipped.
    installFetchMock([
      { date: "2026-05-12", steps: 8420, distance: 6720, calories: 412 },
    ]);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.createMany).mockRejectedValue(
      new Error("db write blew up"),
    );

    // No rethrow — sibling chunks + the rollup fold still run (matches Google).
    await expect(syncUserActivity("user-1")).resolves.toBeGreaterThanOrEqual(0);

    expect(recordSyncSuccess).not.toHaveBeenCalled();
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "withings",
        kind: "transient",
        message: expect.stringContaining("activity batch write failed"),
      }),
    );
  });

  it("tags every row with the canonical externalId so future replays dedup", async () => {
    installFetchMock([{ date: "2026-05-12", steps: 8420 }]);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.createMany).mockResolvedValue({
      count: 1,
    } as never);

    await syncUserActivity("user-1");

    expect(createManyRows()[0].externalId).toBe(
      "withings:activity:user-1:2026-05-12:steps",
    );
  });

  it("batches a multi-day backfill into one read and one insert (F3)", async () => {
    // 5 days × 3 metrics = 15 planned rows. The pre-v1.20.2 shape ran
    // 15 findFirst + 15 create = 30 round-trips; the batched path is one
    // findMany + one createMany regardless of the day count.
    installFetchMock(
      Array.from({ length: 5 }, (_, i) => ({
        date: `2026-05-1${i}`,
        steps: 1000 + i,
        distance: 2000 + i,
        calories: 300 + i,
      })),
    );
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.createMany).mockResolvedValue({
      count: 15,
    } as never);

    const imported = await syncUserActivity("user-1");

    expect(imported).toBe(15);
    expect(prisma.measurement.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.measurement.createMany).toHaveBeenCalledTimes(1);
    expect(createManyRows()).toHaveLength(15);
    // The single read is keyed by the full distinct (type, measuredAt)
    // sets the batch will write — `skipDuplicates` guards the insert.
    const readArg = vi.mocked(prisma.measurement.findMany).mock.calls[0][0] as {
      where: { type: { in: unknown[] }; measuredAt: { in: unknown[] } };
    };
    expect(readArg.where.type.in).toHaveLength(3);
    expect(readArg.where.measuredAt.in).toHaveLength(5);
    const createArg = vi.mocked(prisma.measurement.createMany).mock
      .calls[0][0] as { skipDuplicates: boolean };
    expect(createArg.skipDuplicates).toBe(true);
  });
});

describe("syncUserActivity — scope-skip guard (v1.4.26)", () => {
  it("returns 0 without firing the Withings call when scope lacks user.activity", async () => {
    // Legacy v1.4.24- connection — scope holds `user.metrics` only.
    // The sync must short-circuit BEFORE the upstream fetch so a
    // guaranteed 403 doesn't park as `transient` and spam pg-boss
    // retries.
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
      scope: "user.metrics",
    } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const imported = await syncUserActivity("user-1");

    expect(imported).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.measurement.createMany).not.toHaveBeenCalled();
    expect(recordSyncSuccess).not.toHaveBeenCalled();
  });

  it("parks the connection via parkIntegrationAtReauth (NOT recordSyncFailure) — v1.4.27 F20", async () => {
    // The deliberate scope-skip is a no-op park, not a failure burst.
    // Calling `recordSyncFailure` here would increment the per-user
    // counter and trip the 3-strike admin alert ladder. The v1.4.27
    // fix swaps to `parkIntegrationAtReauth`, which leaves the counter
    // untouched and never pages admins.
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
      scope: "user.metrics",
    } as never);
    vi.stubGlobal("fetch", vi.fn());

    await syncUserActivity("user-1");

    expect(parkIntegrationAtReauth).toHaveBeenCalledTimes(1);
    expect(parkIntegrationAtReauth).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        integration: "withings",
        errorCode: "scope_missing",
      }),
    );
    // CRITICAL: the failure path is NOT touched on a scope-skip — that
    // is what silences the false 3-strike Telegram alert.
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  it("treats a null scope (pre-v1.4.25 connection) as missing user.activity and parks silently", async () => {
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
      scope: null,
    } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const imported = await syncUserActivity("user-1");

    expect(imported).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(parkIntegrationAtReauth).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "scope_missing" }),
    );
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  it("classifies a Withings 403 in the catch-block as reauth_required and STILL pages (defence-in-depth)", async () => {
    // BL-P3-2 — the defence-in-depth 403 catch-block stays on
    // `recordSyncFailure` so a genuinely unexpected 403 (Withings
    // revokes scope between OAuth and the next sync without
    // invalidating the refresh token) still trips the 3-strike alert.
    // This is the asymmetric pair to the scope-skip park above: the
    // park is silent, the catch is loud.
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
      scope: "user.metrics,user.activity",
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 403, error: "insufficient scope" }),
      })),
    );

    await expect(syncUserActivity("user-1")).rejects.toThrow(
      /Withings activity error: 403/,
    );
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reauth_required",
        errorCode: "403",
      }),
    );
    // The park helper is NOT used for the catch — only the scope-skip.
    expect(parkIntegrationAtReauth).not.toHaveBeenCalled();
  });
});

describe("syncUserActivity — measurement rollup hook (v1.4.39.1)", () => {
  it("folds the persistent rollup table for each (type, day) the sync touched", async () => {
    // Two distinct calendar days × three activity metrics each = 6
    // writes; the rollup hook should be called once per distinct
    // `(type, dayStart)` so the dashboard chart's `source=rollup` fast-
    // path lights up the Withings-ingested days. Pre-v1.4.39.1 the
    // sync skipped the hook entirely, leaving the rollup tier blind to
    // Withings activity.
    installFetchMock([
      { date: "2026-05-12", steps: 8420, distance: 6720, calories: 412 },
      { date: "2026-05-13", steps: 9100, distance: 7100, calories: 430 },
    ]);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.createMany).mockResolvedValue({
      count: 0,
    } as never);

    await syncUserActivity("user-1");

    expect(recomputeBucketsForMeasurement).toHaveBeenCalledTimes(6);
    const calls = vi
      .mocked(recomputeBucketsForMeasurement)
      .mock.calls.map((c) => ({
        userId: c[0],
        type: c[1],
        measuredAtIso: (c[2] as Date).toISOString(),
      }));
    // Distinct (type, day) pairs the sync touched, derived from the two
    // dates × three metrics × `collapseToTypeDayKeys`.
    const distinct = new Set(calls.map((c) => `${c.type}|${c.measuredAtIso}`));
    expect(distinct.size).toBe(6);
    expect(calls.every((c) => c.userId === "user-1")).toBe(true);
  });

  it("collapses multiple writes for the same (type, day) into a single rollup recompute", async () => {
    // A single-date entry exercises the existing day-collapse helper —
    // three metric rows for 2026-05-12 must fold into three rollup
    // calls (one per type), not nine.
    installFetchMock([
      { date: "2026-05-12", steps: 8420, distance: 6720, calories: 412 },
    ]);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.createMany).mockResolvedValue({
      count: 0,
    } as never);

    await syncUserActivity("user-1");

    expect(recomputeBucketsForMeasurement).toHaveBeenCalledTimes(3);
  });

  it("swallows a populator failure so the sync still returns its imported count", async () => {
    // The rollup recompute is a best-effort cache tier — a populator
    // hiccup must never fail the user's sync. The sync's `imported`
    // return value should still reflect the rows written.
    installFetchMock([{ date: "2026-05-12", steps: 8420 }]);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.createMany).mockResolvedValue({
      count: 0,
    } as never);
    vi.mocked(recomputeBucketsForMeasurement).mockRejectedValueOnce(
      new Error("simulated rollup failure"),
    );

    const imported = await syncUserActivity("user-1");
    expect(imported).toBe(1);
  });
});
