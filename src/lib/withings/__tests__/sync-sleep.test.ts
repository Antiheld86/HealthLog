/**
 * v1.4.25 W17c — Withings Sleep v2 sync unit tests.
 *
 * Coverage focuses on the state → SleepStage enum mapping, the
 * unix-seconds vs minutes conversion (easy regression trap), and the
 * per-segment write path. End-to-end DB exercise lives in the
 * integration suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reconcileMock, transactionMock } = vi.hoisted(() => ({
  reconcileMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    withingsConnection: { findUnique: vi.fn() },
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/measurements/reconcile-external-measurement", () => ({
  reconcileExternalMeasurement: reconcileMock,
  MeasurementReconciliationError: class extends Error {},
}));

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

// v1.4.39.1 — the sleep sync now folds the persistent measurement
// rollup tier for each touched SLEEP_DURATION day so the dashboard
// chart's `source=rollup` fast-path sees the new segments. The mock
// surfaces the call args for the regression test below.
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

import {
  fetchWithingsSleep,
  mapWithingsSleepState,
  mapWithingsSleepSummary,
  syncUserSleep,
} from "../sync-sleep";

interface FakeSegment {
  startdate: number;
  enddate: number;
  state: number;
  id?: number;
}

function installFetchMock(segments: FakeSegment[]) {
  const fetchMock = vi.fn(async () => ({
    status: 200,
    json: async () => ({
      status: 0,
      body: { series: segments },
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.resetAllMocks();
  transactionMock.mockImplementation(async (run: (tx: unknown) => unknown) =>
    run({}),
  );
  reconcileMock.mockImplementation(
    async (
      _tx: unknown,
      input: { type: string; measuredAt: Date; externalId: string },
    ) => ({
      status: "inserted",
      row: {
        id: `inserted:${input.externalId}`,
        type: input.type,
        measuredAt: input.measuredAt,
        externalId: input.externalId,
      },
    }),
  );
  // v1.4.26 — every syncUserSleep call now reads the connection's
  // scope to short-circuit legacy `user.metrics`-only connections.
  // Default-mock to "scope is fine" so the existing segment-mapping
  // tests stay focused on the write path. The scope-skip case has
  // its own dedicated tests below.
  vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
    scope: "user.metrics,user.activity",
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * v1.18.10 P0 — fetch mock that returns the per-segment series on the first
 * call (`action=get`) and the per-night summary series on the second
 * (`action=getsummary`). Lets the sync exercise both the stage path and the
 * nightly-vital path in one round-trip.
 */
function installSegmentThenSummaryFetch(
  segments: FakeSegment[],
  summaries: Array<{
    id?: number;
    startdate: number;
    enddate: number;
    data?: Record<string, number | null>;
  }>,
) {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const body = call === 0 ? { series: segments } : { series: summaries };
    call++;
    return { status: 200, json: async () => ({ status: 0, body }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("mapWithingsSleepSummary", () => {
  it("maps the canonical nightly vitals to existing enums", () => {
    const rows = mapWithingsSleepSummary({
      hr_average: 58,
      rr_average: 14,
      sdnn_1: 65,
      spo2_average: 96,
      sleep_score: 82,
    });
    const byType = Object.fromEntries(rows.map((r) => [r.type, r.value]));
    expect(byType).toEqual({
      RESTING_HEART_RATE: 58,
      RESPIRATORY_RATE: 14,
      HEART_RATE_VARIABILITY: 65,
      OXYGEN_SATURATION: 96,
      SLEEP_SCORE: 82,
    });
  });

  it("normalises a fractional SpO2 (0..1) to percent", () => {
    const rows = mapWithingsSleepSummary({ spo2_average: 0.97 });
    const spo2 = rows.find((r) => r.type === "OXYGEN_SATURATION");
    expect(spo2?.value).toBeCloseTo(97, 5);
  });

  it("skips omitted / non-finite fields", () => {
    const rows = mapWithingsSleepSummary({
      hr_average: 60,
      rr_average: null,
      sdnn_1: undefined as unknown as number,
      sleep_score: Number.NaN,
    });
    expect(rows.map((r) => r.type)).toEqual(["RESTING_HEART_RATE"]);
  });

  it("returns nothing for an absent data block", () => {
    expect(mapWithingsSleepSummary(undefined)).toEqual([]);
  });
});

describe("mapWithingsSleepState", () => {
  it("maps state 0 (awake) → AWAKE", () => {
    expect(mapWithingsSleepState(0)).toBe("AWAKE");
  });

  it("maps state 1 (light) → CORE (HealthKit-aligned NREM 1+2)", () => {
    expect(mapWithingsSleepState(1)).toBe("CORE");
  });

  it("maps state 2 (deep) → DEEP", () => {
    expect(mapWithingsSleepState(2)).toBe("DEEP");
  });

  it("maps state 3 (REM) → REM", () => {
    expect(mapWithingsSleepState(3)).toBe("REM");
  });

  it("returns null for state 4 (synthetic marker — ignored)", () => {
    expect(mapWithingsSleepState(4)).toBeNull();
  });

  it("returns null for any unknown state value", () => {
    expect(mapWithingsSleepState(99)).toBeNull();
    expect(mapWithingsSleepState(-1)).toBeNull();
  });
});

describe("fetchWithingsSleep", () => {
  it("POSTs sleep get with unix-seconds startdate + enddate", async () => {
    const fetchMock = installFetchMock([]);
    await fetchWithingsSleep("token", 1715000000, 1715100000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://wbsapi.withings.net/v2/sleep");
    const body = String(init.body);
    expect(body).toContain("action=get");
    expect(body).toContain("startdate=1715000000");
    expect(body).toContain("enddate=1715100000");
  });

  it("throws when Withings returns a non-zero status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 293 }),
      })),
    );
    await expect(
      fetchWithingsSleep("token", 1715000000, 1715100000),
    ).rejects.toThrow(/Withings sleep error: 293/);
  });
});

describe("syncUserSleep — segment writes + idempotency", () => {
  it("writes one row per stage segment with the mapped SleepStage", async () => {
    // A typical night: 4 segments — light, deep, REM, light.
    const base = 1715000000;
    installFetchMock([
      { startdate: base, enddate: base + 3600, state: 1, id: 99 }, // 60 min CORE
      { startdate: base + 3600, enddate: base + 5400, state: 2, id: 99 }, // 30 min DEEP
      { startdate: base + 5400, enddate: base + 7200, state: 3, id: 99 }, // 30 min REM
      { startdate: base + 7200, enddate: base + 7800, state: 0, id: 99 }, // 10 min AWAKE
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const imported = await syncUserSleep("user-1");
    expect(imported).toBe(4);

    const writes = reconcileMock.mock.calls.map((call) => call[1]);
    expect(writes.map((row) => row.sleepStage)).toEqual([
      "CORE",
      "DEEP",
      "REM",
      "AWAKE",
    ]);
    expect(writes[0]).toMatchObject({ value: 60, unit: "minutes" });
  });

  it("stamps measuredAt at the segment END (enddate, unix seconds → Date)", async () => {
    installFetchMock([
      { startdate: 1715000000, enddate: 1715003600, state: 2, id: 1 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    await syncUserSleep("user-1");
    const row = reconcileMock.mock.calls[0]![1] as { measuredAt: Date };
    // measuredAt is the segment END — every reader treats it as the END and
    // resolves the span as start = end − duration. Stamping the START shifted
    // the night one segment-length earlier.
    expect(row.measuredAt.getTime()).toBe(1715003600 * 1000);
  });

  it("skips state 4 (synthetic marker) without throwing", async () => {
    installFetchMock([
      { startdate: 1715000000, enddate: 1715003600, state: 4, id: 1 },
      { startdate: 1715003600, enddate: 1715007200, state: 2, id: 1 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const imported = await syncUserSleep("user-1");
    expect(imported).toBe(1);
    const stages = reconcileMock.mock.calls.map((call) => call[1].sleepStage);
    expect(stages).toEqual(["DEEP"]);
  });

  it("updates existing rows on a re-sync rather than inserting duplicates", async () => {
    installFetchMock([
      { startdate: 1715000000, enddate: 1715003600, state: 2, id: 1 },
    ]);
    reconcileMock.mockResolvedValueOnce({
      status: "updated",
      row: {
        id: "row-1",
        type: "SLEEP_DURATION",
        measuredAt: new Date(1715003600 * 1000),
        externalId: "withings:sleep:user-1:1:1715000000",
      },
    });

    const imported = await syncUserSleep("user-1");
    expect(imported).toBe(1);
    expect(reconcileMock.mock.calls[0]![1]).toMatchObject({
      value: 60,
      measuredAt: new Date(1715003600 * 1000),
      sleepStage: "DEEP",
      externalId: "withings:sleep:user-1:1:1715000000",
    });
  });

  it("re-keys a re-scored segment in place via the natural key instead of colliding (F3, 0055 wedge)", async () => {
    // Withings re-scores a night: the segment's END (measuredAt + the 0055
    // natural key) stays fixed while its START (externalId) shifts, same stage.
    // The externalId probe MISSES (new START ⇒ new id), but the natural key
    // `(userId, type, measuredAt, source, sleepStage)` is still occupied by the
    // prior row. A blind create would P2002 on it (swallowed → row lost, then
    // the sweep tombstones the old row → the night wedges forever). The
    // natural-key rescue must UPDATE the surviving row in place, re-keying it.
    installFetchMock([
      { startdate: 1715000500, enddate: 1715003600, state: 2, id: 42 },
    ]);
    const imported = await syncUserSleep("user-1");
    expect(imported).toBe(1);
    expect(reconcileMock.mock.calls[0]![1]).toMatchObject({
      value: expect.any(Number),
      measuredAt: new Date(1715003600 * 1000),
      sleepStage: "DEEP",
      externalId: "withings:sleep:user-1:42:1715000500",
    });
  });

  it("stamps every row with an externalId keyed on session id + segment START", async () => {
    installFetchMock([
      { startdate: 1715000000, enddate: 1715003600, state: 2, id: 42 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    await syncUserSleep("user-1");
    const row = reconcileMock.mock.calls[0]![1] as { externalId: string };
    // Session id + the segment's own startdate — both stable within a session.
    // The retired running index counted across the whole rolling 30-day fetch
    // window, so the window slide renumbered every segment on each sync and a
    // re-aggregated night inserted a duplicate set.
    expect(row.externalId).toBe("withings:sleep:user-1:42:1715000000");
  });

  it("mints IDENTICAL externalIds when the fetch window slides (re-fetch of the same night)", async () => {
    // The same two segments of session 42, fetched twice: the second fetch's
    // window has slid so the series now carries an EXTRA leading segment from
    // a different session — under the retired running index this shifted
    // every index of session 42 (0,1 → 1,2), minting fresh ids that inserted
    // a duplicate night. The start-keyed ids must be identical across fetches.
    const night = [
      { startdate: 1715000000, enddate: 1715003600, state: 1, id: 42 },
      { startdate: 1715003600, enddate: 1715005400, state: 2, id: 42 },
    ];
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    installFetchMock(night);
    await syncUserSleep("user-1");
    const firstIds = reconcileMock.mock.calls.map(
      (call) => call[1].externalId as string,
    );

    reconcileMock.mockClear();
    installFetchMock([
      { startdate: 1714990000, enddate: 1714993600, state: 1, id: 7 },
      ...night,
    ]);
    await syncUserSleep("user-1");
    const secondIds = reconcileMock.mock.calls
      .map((call) => call[1].externalId as string)
      .filter((id) => id.includes(":42:"));

    expect(secondIds).toEqual(firstIds);
  });

  it("sweeps stale rows per fetched session: live-only, session-prefixed, notIn the fresh set, soft-delete (v1.28.25)", async () => {
    installFetchMock([
      { startdate: 1715000000, enddate: 1715003600, state: 1, id: 42 },
      { startdate: 1715003600, enddate: 1715005400, state: 2, id: 42 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);
    vi.mocked(prisma.measurement.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    await syncUserSleep("user-1");

    expect(prisma.measurement.updateMany).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.measurement.updateMany).mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({
      userId: "user-1",
      source: "WITHINGS",
      type: "SLEEP_DURATION",
      deletedAt: null,
      externalId: {
        startsWith: "withings:sleep:user-1:42:",
        notIn: [
          "withings:sleep:user-1:42:1715000000",
          "withings:sleep:user-1:42:1715003600",
        ],
      },
    });
    expect(arg.data).toEqual({ deletedAt: expect.any(Date) });

    // A legacy running-index row for this session falls inside the sweep:
    // under the session prefix, never in the fresh start-keyed set.
    const where = arg.where as {
      externalId: { startsWith: string; notIn: string[] };
    };
    const legacyId = "withings:sleep:user-1:42:0";
    expect(legacyId.startsWith(where.externalId.startsWith)).toBe(true);
    expect(where.externalId.notIn).not.toContain(legacyId);
  });

  it("never sweeps sessions absent from this fetch (no id → no sweep entry)", async () => {
    // Segments without a session id cannot be bounded to one night — their
    // shared `no-id` prefix would span every id-less night in history — so
    // they must not produce a sweep.
    installFetchMock([
      { startdate: 1715000000, enddate: 1715003600, state: 2 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const imported = await syncUserSleep("user-1");
    expect(imported).toBe(1);
    expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
  });

  it("calls recordSyncSuccess after a clean round-trip", async () => {
    installFetchMock([]);
    await syncUserSleep("user-1");
    expect(recordSyncSuccess).toHaveBeenCalledWith("user-1", "withings", {
      leg: "sleep",
    });
  });

  it("W-3 — records a transient failure and rethrows when a sleep write throws", async () => {
    // A reconcile throw out of the stage transaction used to propagate past the
    // success stamp and get swallowed by both callers: neither success NOR
    // failure recorded, `lastAttemptAt` quietly stale. Now the source records a
    // transient failure and rethrows (callers keep their warn-and-continue).
    installFetchMock([
      { startdate: 1715000000, enddate: 1715003600, state: 2, id: 1 },
    ]);
    reconcileMock.mockReset().mockResolvedValueOnce({
      status: "failed",
      reason: "db_error",
      error: new Error("reconcile boom"),
    });

    await expect(syncUserSleep("user-1")).rejects.toThrow();

    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "withings",
        kind: "transient",
        message: expect.stringContaining("sleep write failed"),
      }),
    );
    expect(recordSyncSuccess).not.toHaveBeenCalled();
  });

  it("upserts nightly vitals with stable per-vital externalIds (v1.18.10 P0)", async () => {
    const nightEnd = Math.floor(Date.UTC(2026, 4, 13, 6) / 1000);
    installSegmentThenSummaryFetch(
      [],
      [
        {
          id: 555,
          startdate: nightEnd - 8 * 3600,
          enddate: nightEnd,
          data: {
            hr_average: 57,
            rr_average: 13,
            sdnn_1: 70,
            spo2_average: 95,
            sleep_score: 88,
          },
        },
      ],
    );
    reconcileMock.mockResolvedValue({ status: "updated", row: {} });

    const imported = await syncUserSleep("user-1");
    // Five vitals upserted (no stage segments in this fixture).
    expect(imported).toBe(5);

    const byType = new Map(
      reconcileMock.mock.calls.map((call) => {
        const row = call[1] as {
          type: string;
          externalId: string;
          value: number;
        };
        return [row.type, { externalId: row.externalId, value: row.value }];
      }),
    );
    expect(byType.get("RESTING_HEART_RATE")).toEqual({
      externalId: "withings:sleep:user-1:555:hr",
      value: 57,
    });
    expect(byType.get("SLEEP_SCORE")).toEqual({
      externalId: "withings:sleep:user-1:555:score",
      value: 88,
    });
    expect(byType.get("OXYGEN_SATURATION")?.value).toBe(95);
  });

  it("keeps stage segments when the summary fetch fails (v1.18.10 P0)", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const isSummary = call > 0;
        call++;
        return {
          status: 200,
          json: async () =>
            isSummary
              ? { status: 293 } // summary errors
              : {
                  status: 0,
                  body: {
                    series: [
                      {
                        startdate: 1715000000,
                        enddate: 1715003600,
                        state: 2,
                        id: 1,
                      },
                    ],
                  },
                },
        };
      }),
    );
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const imported = await syncUserSleep("user-1");
    // The one stage segment is still written; the summary failure is swallowed.
    expect(imported).toBe(1);
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(recordSyncSuccess).toHaveBeenCalledWith("user-1", "withings", {
      leg: "sleep",
    });
  });

  it("tolerates a ScanWatch night with no REM segment (no all-zeros row)", async () => {
    // ScanWatch reports CORE + DEEP only; a missing REM should NOT
    // synthesise an all-zeros REM row. Withings simply omits the
    // segment, so the writer never sees it.
    installFetchMock([
      { startdate: 1715000000, enddate: 1715003600, state: 1, id: 7 },
      { startdate: 1715003600, enddate: 1715005400, state: 2, id: 7 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const imported = await syncUserSleep("user-1");
    expect(imported).toBe(2);
    const stages = reconcileMock.mock.calls.map((call) => call[1].sleepStage);
    expect(stages).not.toContain("REM");
  });
});

describe("syncUserSleep — scope-skip guard (v1.4.26)", () => {
  it("returns 0 without firing the Withings call when scope lacks user.activity", async () => {
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
      scope: "user.metrics",
    } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const imported = await syncUserSleep("user-1");

    expect(imported).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(recordSyncSuccess).not.toHaveBeenCalled();
  });

  it("parks the connection via parkIntegrationAtReauth (NOT recordSyncFailure) — v1.4.27 F20 + BL-P3-2 parity", async () => {
    // BL-P3-2 — sleep mirrors activity. The deliberate scope-skip is a
    // no-op park, not a failure burst; calling `recordSyncFailure`
    // here would increment the counter and could trip the 3-strike
    // admin alert ladder. Swap to `parkIntegrationAtReauth`.
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
      scope: "user.metrics",
    } as never);
    vi.stubGlobal("fetch", vi.fn());

    await syncUserSleep("user-1");

    expect(parkIntegrationAtReauth).toHaveBeenCalledTimes(1);
    expect(parkIntegrationAtReauth).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        integration: "withings",
        errorCode: "scope_missing",
      }),
    );
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  it("treats a null scope (pre-v1.4.25 connection) as missing user.activity and parks silently", async () => {
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValue({
      scope: null,
    } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const imported = await syncUserSleep("user-1");

    expect(imported).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(parkIntegrationAtReauth).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "scope_missing" }),
    );
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  it("classifies a Withings 403 in the catch-block as reauth_required and STILL pages (defence-in-depth)", async () => {
    // BL-P3-2 — symmetric to sync-activity. The catch-block stays on
    // `recordSyncFailure` because a 403 reaching the catch IS
    // genuinely unexpected after the scope-skip lands above. The
    // 3-strike alert ladder fires here.
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

    await expect(syncUserSleep("user-1")).rejects.toThrow(
      /Withings sleep error: 403/,
    );
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reauth_required",
        errorCode: "403",
      }),
    );
    expect(parkIntegrationAtReauth).not.toHaveBeenCalled();
  });
});

describe("syncUserSleep — measurement rollup hook (v1.4.39.1)", () => {
  it("folds the persistent rollup table once per night the sync touched", async () => {
    // Two distinct nights, each with multiple stage segments. The
    // sync should collapse the per-night segments to one rollup
    // recompute per night via `collapseToTypeDayKeys`. Pre-v1.4.39.1
    // the rollup tier never heard about Withings sleep at all.
    const nightA = Math.floor(Date.UTC(2026, 4, 12, 22) / 1000); // 2026-05-12 22:00 UTC
    const nightB = Math.floor(Date.UTC(2026, 4, 13, 22) / 1000); // 2026-05-13 22:00 UTC
    installFetchMock([
      { startdate: nightA, enddate: nightA + 3600, state: 1, id: 1 },
      { startdate: nightA + 3600, enddate: nightA + 5400, state: 2, id: 1 },
      { startdate: nightA + 5400, enddate: nightA + 7200, state: 3, id: 1 },
      { startdate: nightB, enddate: nightB + 3600, state: 1, id: 2 },
      { startdate: nightB + 3600, enddate: nightB + 5400, state: 2, id: 2 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    await syncUserSleep("user-1");

    // Both segments of night A land in the same UTC day; night B in
    // the next. Distinct (SLEEP_DURATION, dayStart) tuples = 2.
    expect(recomputeBucketsForMeasurement).toHaveBeenCalledTimes(2);
    const types = vi
      .mocked(recomputeBucketsForMeasurement)
      .mock.calls.map((c) => c[1]);
    expect(new Set(types)).toEqual(new Set(["SLEEP_DURATION"]));
  });

  it("swallows a populator failure so the sync still returns its imported count", async () => {
    installFetchMock([
      { startdate: 1715000000, enddate: 1715003600, state: 2, id: 1 },
    ]);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);
    vi.mocked(recomputeBucketsForMeasurement).mockRejectedValueOnce(
      new Error("simulated rollup failure"),
    );

    const imported = await syncUserSleep("user-1");
    expect(imported).toBe(1);
  });
});
