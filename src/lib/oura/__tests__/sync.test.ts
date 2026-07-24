import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getConnMock,
  storeTokensMock,
  getCredsMock,
  fetchReadinessMock,
  fetchSleepMock,
  fetchActivityMock,
  fetchDailySleepMock,
  fetchSpo2Mock,
  fetchVo2MaxMock,
  fetchCardioAgeMock,
  fetchResilienceMock,
  fetchCyclePhasesMock,
  refreshMock,
  createManyAndReturnMock,
  updateMock,
  findManyMock,
  updateManyMock,
  emitArrivalMock,
  recordSuccessMock,
  recordFailureMock,
  recomputeMock,
  invalidateMock,
  transactionMock,
  reconcileMock,
} = vi.hoisted(() => ({
  getConnMock: vi.fn(),
  storeTokensMock: vi.fn(),
  getCredsMock: vi.fn(),
  fetchReadinessMock: vi.fn(),
  fetchSleepMock: vi.fn(),
  fetchActivityMock: vi.fn(),
  fetchDailySleepMock: vi.fn(),
  fetchSpo2Mock: vi.fn(),
  fetchVo2MaxMock: vi.fn(),
  fetchCardioAgeMock: vi.fn(),
  fetchResilienceMock: vi.fn(),
  fetchCyclePhasesMock: vi.fn(),
  refreshMock: vi.fn(),
  createManyAndReturnMock: vi.fn(),
  updateMock: vi.fn(),
  findManyMock: vi.fn(),
  updateManyMock: vi.fn(),
  emitArrivalMock: vi.fn(),
  recordSuccessMock: vi.fn(),
  recordFailureMock: vi.fn(),
  recomputeMock: vi.fn(),
  invalidateMock: vi.fn(),
  transactionMock: vi.fn(),
  reconcileMock: vi.fn(),
}));

vi.mock("../credentials", () => ({
  getOuraConnection: getConnMock,
  storeOuraTokens: storeTokensMock,
  getOuraClientCredentials: getCredsMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      createManyAndReturn: createManyAndReturnMock,
      update: updateMock,
      findMany: findManyMock,
      updateMany: updateManyMock,
    },
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/measurements/reconcile-external-measurement", () => ({
  reconcileExternalMeasurement: reconcileMock,
  MeasurementReconciliationError: class extends Error {},
}));

vi.mock("@/lib/integrations/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/status")>()),
  recordSyncSuccess: recordSuccessMock,
  recordSyncFailure: recordFailureMock,
}));

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: (rows: Array<{ type: string; measuredAt: Date }>) =>
    rows.map((r) => ({ type: r.type, measuredAt: r.measuredAt })),
  recomputeBucketsForMeasurement: recomputeMock,
}));

vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: invalidateMock,
}));

vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: emitArrivalMock,
}));

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>();
  return {
    ...actual,
    fetchReadiness: fetchReadinessMock,
    fetchSleep: fetchSleepMock,
    fetchDailyActivity: fetchActivityMock,
    fetchDailySleep: fetchDailySleepMock,
    fetchDailySpo2: fetchSpo2Mock,
    fetchVo2Max: fetchVo2MaxMock,
    fetchCardiovascularAge: fetchCardioAgeMock,
    fetchResilience: fetchResilienceMock,
    fetchDailyCyclePhases: fetchCyclePhasesMock,
    refreshAccessToken: refreshMock,
  };
});

import { syncUserOura, upsertOuraMeasurements } from "../sync";
import { OuraApiError } from "../response-classifier";
import { isSyncFailureRecorded } from "@/lib/integrations/status";

const CONN = {
  accessToken: "acc",
  refreshToken: "ref",
  refreshTokenCiphertext: "enc(ref)",
};

beforeEach(() => {
  getConnMock.mockReset();
  // The compare-and-swap persist returns the access token the caller should use
  // (its own on a CAS win) — default to the freshly minted one.
  storeTokensMock.mockReset().mockResolvedValue("newAcc");
  getCredsMock
    .mockReset()
    .mockResolvedValue({ clientId: "c", clientSecret: "s" });
  fetchReadinessMock.mockReset().mockResolvedValue([]);
  fetchSleepMock.mockReset().mockResolvedValue([]);
  fetchActivityMock.mockReset().mockResolvedValue([]);
  fetchDailySleepMock.mockReset().mockResolvedValue([]);
  fetchSpo2Mock.mockReset().mockResolvedValue([]);
  fetchVo2MaxMock.mockReset().mockResolvedValue([]);
  fetchCardioAgeMock.mockReset().mockResolvedValue([]);
  fetchResilienceMock.mockReset().mockResolvedValue([]);
  fetchCyclePhasesMock.mockReset().mockResolvedValue([]);
  refreshMock.mockReset();
  transactionMock
    .mockReset()
    .mockImplementation(async (run: (tx: unknown) => unknown) => run({}));
  reconcileMock
    .mockReset()
    .mockImplementation(
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
  createManyAndReturnMock.mockReset().mockImplementation(
    async ({
      data,
    }: {
      data: Array<{
        type: string;
        measuredAt: Date;
        externalId: string;
      }>;
    }) =>
      data.map((row, index) => ({
        id: `inserted-${index}`,
        type: row.type,
        measuredAt: row.measuredAt,
        externalId: row.externalId,
      })),
  );
  updateMock.mockReset().mockResolvedValue({});
  findManyMock.mockReset();
  updateManyMock.mockReset().mockResolvedValue({ count: 0 });
  emitArrivalMock.mockReset().mockResolvedValue(undefined);
  recordSuccessMock.mockReset().mockResolvedValue(undefined);
  recordFailureMock.mockReset().mockResolvedValue(undefined);
  recomputeMock.mockReset().mockResolvedValue(undefined);
  invalidateMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

function err401() {
  return new OuraApiError({
    verb: "fetchReadiness",
    classification: "reauth_required",
    httpStatus: 401,
    reason: "http_401",
  });
}

function createdRows() {
  return reconcileMock.mock.calls.map((call) => call[1]);
}

describe("syncUserOura", () => {
  it("no-ops cleanly when unconnected", async () => {
    getConnMock.mockResolvedValue(null);
    expect(await syncUserOura("u1")).toBe(0);
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("writes a readiness RECOVERY_SCORE with source OURA", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchReadinessMock.mockResolvedValue([
      { id: "x", day: "2026-06-10", score: 84 },
    ]);
    const imported = await syncUserOura("u1");
    expect(imported).toBe(1);
    const row = createdRows()[0];
    expect(row).toMatchObject({
      userId: "u1",
      type: "RECOVERY_SCORE",
      source: "OURA",
      externalId: "readiness:2026-06-10:recovery",
      value: 84,
    });
    expect(recordSuccessMock).toHaveBeenCalledWith("u1", "oura");
  });

  it("refreshes the token on a 401 and retries once", async () => {
    getConnMock.mockResolvedValue(CONN);
    // First call (with old token) 401s; after refresh the retry succeeds.
    fetchReadinessMock
      .mockRejectedValueOnce(err401())
      .mockResolvedValueOnce([{ id: "x", day: "2026-06-10", score: 70 }]);
    refreshMock.mockResolvedValue({
      access_token: "newAcc",
      refresh_token: "newRef",
      expires_in: 86400,
    });
    const imported = await syncUserOura("u1");
    expect(refreshMock).toHaveBeenCalledWith("ref", expect.anything());
    expect(storeTokensMock).toHaveBeenCalledWith(
      "u1",
      "newAcc",
      "newRef",
      "enc(ref)",
    );
    expect(imported).toBe(1);
    expect(recordSuccessMock).toHaveBeenCalledWith("u1", "oura");
  });

  it("reuses the peer's rotated token on a lost CAS race and still completes (no reauth)", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchReadinessMock
      .mockRejectedValueOnce(err401())
      .mockResolvedValueOnce([{ id: "x", day: "2026-06-10", score: 70 }]);
    refreshMock.mockResolvedValue({
      access_token: "newAcc",
      refresh_token: "newRef",
      expires_in: 86400,
    });
    // A concurrent sync rotated first → the persist returns the PEER's token.
    storeTokensMock.mockResolvedValue("peerAcc");

    const imported = await syncUserOura("u1");

    // The retry runs with the peer's token rather than the invalidated one.
    expect(fetchReadinessMock).toHaveBeenLastCalledWith(
      "peerAcc",
      expect.anything(),
    );
    expect(imported).toBe(1);
    expect(recordFailureMock).not.toHaveBeenCalled();
  });

  it("records reauth_required when the refresh itself fails", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchReadinessMock.mockRejectedValue(err401());
    refreshMock.mockRejectedValue(
      new OuraApiError({
        verb: "refreshAccessToken",
        classification: "reauth_required",
        httpStatus: 400,
        reason: "http_400",
        upstreamError: "invalid_grant",
      }),
    );
    const err = await syncUserOura("u1").catch((e) => e);
    expect(err).toBeInstanceOf(OuraApiError);
    // Recorded at the source AND marked, so the poll-cohort boundary does not
    // record it a second time.
    expect(isSyncFailureRecorded(err)).toBe(true);
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    expect(recordFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ integration: "oura", kind: "reauth_required" }),
    );
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("leaves a write-path failure UNMARKED so the cohort boundary records it once", async () => {
    // The `upsertOuraMeasurements` transaction throw escapes `syncUserOura`
    // uncaught: no source-site record, no mark — the poll-cohort boundary is
    // what records it (exactly once).
    getConnMock.mockResolvedValue(CONN);
    fetchReadinessMock.mockResolvedValue([
      { id: "r1", day: "2026-06-10", score: 71 },
    ]);
    reconcileMock.mockResolvedValue({
      status: "failed",
      reason: "db_error",
      error: new Error("write boom"),
    });

    const err = await syncUserOura("u1").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isSyncFailureRecorded(err)).toBe(false);
    expect(recordFailureMock).not.toHaveBeenCalled();
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("keeps a nap and the main sleep distinct via record-scoped externalIds (B2)", async () => {
    getConnMock.mockResolvedValue(CONN);
    // Two sleep records on the same day: a main sleep + a nap.
    fetchSleepMock.mockResolvedValue([
      { id: "main", day: "2026-06-10", deep_sleep_duration: 3600 },
      { id: "nap", day: "2026-06-10", deep_sleep_duration: 1200 },
    ]);
    await syncUserOura("u1");
    const externalIds = createdRows().map((row) => row.externalId);
    expect(externalIds).toContain("sleep:main:sleep_deep");
    expect(externalIds).toContain("sleep:nap:sleep_deep");
    // The legacy day-keyed collapse would have produced one shared key.
    expect(new Set(externalIds).size).toBe(externalIds.length);
  });

  it("sweeps stale sleep rows per fetched record: live-only, record-prefixed, notIn the fresh set, soft-delete (v1.28.25)", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchSleepMock.mockResolvedValue([
      {
        id: "rec-T",
        day: "2026-06-10",
        bedtime_start: "2026-06-09T23:00:00.000Z",
        bedtime_end: "2026-06-10T07:00:00.000Z",
        sleep_phase_5_min: "1122234",
      },
    ]);

    await syncUserOura("u1");

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const arg = updateManyMock.mock.calls[0]![0] as {
      where: {
        userId: string;
        source: string;
        type: string;
        deletedAt: null;
        externalId: { startsWith: string; notIn: string[] };
      };
      data: Record<string, unknown>;
    };
    expect(arg.where.userId).toBe("u1");
    expect(arg.where.source).toBe("OURA");
    expect(arg.where.type).toBe("SLEEP_DURATION");
    expect(arg.where.deletedAt).toBeNull();
    // Bounded to THIS record. The prefix covers the whole record slice (runs
    // AND the stage-total fallback shape) so a night that flips between the
    // two shapes cannot leave the other shape's rows double-counting.
    expect(arg.where.externalId.startsWith).toBe("sleep:rec-T:");
    // Every fresh SLEEP_DURATION id of the record is protected.
    expect(arg.where.externalId.notIn).toEqual([
      "sleep:rec-T:seg:2026-06-09T23:00:00.000Z",
      "sleep:rec-T:seg:2026-06-09T23:10:00.000Z",
      "sleep:rec-T:seg:2026-06-09T23:25:00.000Z",
      "sleep:rec-T:seg:2026-06-09T23:30:00.000Z",
    ]);
    // Soft delete only.
    expect(arg.data).toEqual({ deletedAt: expect.any(Date) });

    // A legacy run-indexed row for this record falls inside the sweep.
    const legacyId = "sleep:rec-T:seg:0";
    expect(legacyId.startsWith(arg.where.externalId.startsWith)).toBe(true);
    expect(arg.where.externalId.notIn).not.toContain(legacyId);

    // Replace-then-write: the sweep runs before the insert statement.
    expect(updateManyMock.mock.invocationCallOrder[0]!).toBeLessThan(
      reconcileMock.mock.invocationCallOrder[0]!,
    );
  });

  it("never sweeps when the sleep collection returns no records", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchReadinessMock.mockResolvedValue([
      { id: "1", day: "2026-06-10", score: 70 },
    ]);
    await syncUserOura("u1");
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("writes the Sleep Score and SpO2 from the new collections", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchDailySleepMock.mockResolvedValue([
      { id: "s", day: "2026-06-10", score: 80 },
    ]);
    fetchSpo2Mock.mockResolvedValue([
      { id: "o", day: "2026-06-10", spo2_percentage: { average: 97 } },
    ]);
    await syncUserOura("u1");
    const written = createdRows();
    expect(written).toContainEqual(
      expect.objectContaining({
        type: "SLEEP_SCORE",
        externalId: "daily_sleep:2026-06-10:sleep_score",
        value: 80,
      }),
    );
    expect(written).toContainEqual(
      expect.objectContaining({
        type: "OXYGEN_SATURATION",
        externalId: "spo2:2026-06-10:spo2",
        value: 97,
      }),
    );
  });

  it("writes VO2_MAX from the dedicated collection", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchVo2MaxMock.mockResolvedValue([
      { id: "v", day: "2026-06-10", vo2_max: 47.3 },
    ]);
    await syncUserOura("u1");
    const written = createdRows();
    expect(written).toContainEqual(
      expect.objectContaining({
        type: "VO2_MAX",
        externalId: "vo2max:2026-06-10:vo2_max",
        value: 47.3,
      }),
    );
    // daily_stress → STRESS_SCORE is withdrawn pending ladder wiring.
    expect(written.some((w) => w.type === "STRESS_SCORE")).toBe(false);
  });

  it("writes RESILIENCE ordinal-encoded from the daily_resilience collection", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchResilienceMock.mockResolvedValue([
      { id: "r", day: "2026-06-10", level: "strong" },
    ]);
    const imported = await syncUserOura("u1");
    expect(imported).toBe(1);
    const row = createdRows()[0];
    expect(row).toMatchObject({
      type: "RESILIENCE",
      source: "OURA",
      externalId: "resilience:2026-06-10:resilience",
      value: 4,
      unit: "level",
    });
  });

  it("skips an unrecognised resilience level (no row)", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchResilienceMock.mockResolvedValue([
      { id: "r", day: "2026-06-10", level: "godlike" },
    ]);
    const imported = await syncUserOura("u1");
    expect(imported).toBe(0);
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("re-sync of the same day upserts RESILIENCE in place (overwrite, not duplicate)", async () => {
    getConnMock.mockResolvedValue(CONN);
    // Oura finalises a day's level after the night; a re-fetch reports a
    // different level on the SAME day → the day-keyed externalId stays stable
    // so the upsert update branch overwrites in place.
    fetchResilienceMock
      .mockResolvedValueOnce([
        { id: "r", day: "2026-06-10", level: "adequate" },
      ])
      .mockResolvedValueOnce([{ id: "r", day: "2026-06-10", level: "solid" }]);
    reconcileMock
      .mockResolvedValueOnce({
        status: "inserted",
        row: {
          id: "inserted-resilience",
          type: "RESILIENCE",
          measuredAt: new Date("2026-06-10T00:00:00.000Z"),
          externalId: "resilience:2026-06-10:resilience",
        },
      })
      .mockResolvedValueOnce({
        status: "updated",
        row: {
          id: "inserted-resilience",
          type: "RESILIENCE",
          measuredAt: new Date("2026-06-10T00:00:00.000Z"),
          externalId: "resilience:2026-06-10:resilience",
        },
      });
    await syncUserOura("u1");
    await syncUserOura("u1");
    const writes = reconcileMock.mock.calls.map((call) => call[1]);
    expect(writes.map((row) => row.externalId)).toEqual([
      "resilience:2026-06-10:resilience",
      "resilience:2026-06-10:resilience",
    ]);
    expect(writes[0].value).toBe(2);
    expect(writes[1].value).toBe(3);
  });

  it("does NOT refresh on a 403 (not an expiry case)", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchReadinessMock.mockRejectedValue(
      new OuraApiError({
        verb: "fetchReadiness",
        classification: "reauth_required",
        httpStatus: 403,
        reason: "http_403",
      }),
    );
    // A 403 is a per-collection hard failure now (isolated, not a whole-batch
    // reject): it records a partial failure and does NOT trigger a refresh.
    await syncUserOura("u1");
    expect(refreshMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ integration: "oura" }),
    );
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("isolates one bad collection — siblings still import (F-SYNC-2)", async () => {
    getConnMock.mockResolvedValue(CONN);
    // Readiness endpoint is flaky (500), but sleep-score + spo2 return data.
    fetchReadinessMock.mockRejectedValue(
      new OuraApiError({
        verb: "fetchReadiness",
        classification: "transient",
        httpStatus: 500,
        reason: "http_500",
      }),
    );
    fetchDailySleepMock.mockResolvedValue([
      { id: "s", day: "2026-06-10", score: 80 },
    ]);
    fetchSpo2Mock.mockResolvedValue([
      { id: "o", day: "2026-06-10", spo2_percentage: { average: 97 } },
    ]);

    const imported = await syncUserOura("u1");

    // The healthy collections still wrote their rows — the source is not blanked.
    expect(imported).toBe(2);
    const written = createdRows().map((row) => row.type);
    expect(written).toContain("SLEEP_SCORE");
    expect(written).toContain("OXYGEN_SATURATION");
    // The cycle is still marked failed (partial) so freshness stays honest.
    expect(recordFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ integration: "oura" }),
    );
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("isolates a throwing mapper — one malformed record does not blank siblings (F-SYNC-2)", async () => {
    getConnMock.mockResolvedValue(CONN);
    // A malformed readiness record whose mapper throws must not reject the
    // whole batch (the old Promise.all failure mode).
    fetchReadinessMock.mockReturnValue(
      Promise.resolve([
        new Proxy(
          {},
          {
            get() {
              throw new Error("malformed readiness point");
            },
          },
        ),
      ]),
    );
    fetchSpo2Mock.mockResolvedValue([
      { id: "o", day: "2026-06-10", spo2_percentage: { average: 96 } },
    ]);

    const imported = await syncUserOura("u1");

    expect(imported).toBe(1);
    const written = createdRows().map((row) => row.type);
    expect(written).toContain("OXYGEN_SATURATION");
    expect(recordFailureMock).toHaveBeenCalled();
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("degrades gracefully when daily_cycle_phases 403s — the measurement sync still succeeds (F4/cycle)", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchReadinessMock.mockResolvedValue([
      { id: "1", day: "2026-06-10", score: 70 },
    ]);
    // The endpoint is undocumented / gated for most connections — a 403 here
    // must never surface as a whole-connection reauth prompt.
    fetchCyclePhasesMock.mockRejectedValue(
      new OuraApiError({
        verb: "fetchDailyCyclePhases",
        classification: "reauth_required",
        httpStatus: 403,
        reason: "http_403",
      }),
    );
    const imported = await syncUserOura("u1");
    expect(imported).toBe(1);
    expect(recordSuccessMock).toHaveBeenCalledWith("u1", "oura");
    expect(recordFailureMock).not.toHaveBeenCalled();
  });

  it("re-reads the connection for the cycle-phases fetch (picks up a rotated token)", async () => {
    getConnMock.mockResolvedValue(CONN);
    await syncUserOura("u1");
    expect(fetchCyclePhasesMock).toHaveBeenCalledWith(
      CONN.accessToken,
      expect.objectContaining({
        startDate: expect.any(String),
        endDate: expect.any(String),
      }),
    );
    // Once for the measurement-sync token, once more for the cycle-phases
    // fetch's fresh read.
    expect(getConnMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a cycle-phases fetch error never blocks morning-refresh / rollup tail work", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchDailySleepMock.mockResolvedValue([
      { id: "s", day: "2026-06-10", score: 80 },
    ]);
    fetchCyclePhasesMock.mockRejectedValue(new Error("boom"));
    const imported = await syncUserOura("u1");
    expect(imported).toBe(1);
    expect(recordSuccessMock).toHaveBeenCalledWith("u1", "oura");
  });
});

describe("upsertOuraMeasurements — exact insertion results", () => {
  const measuredAt = new Date("2026-06-10T08:00:00.000Z");
  const readings = [
    {
      type: "RECOVERY_SCORE" as const,
      value: 84,
      unit: "score",
      measuredAt,
      externalId: "readiness:2026-06-10:recovery",
    },
    {
      type: "HRV_RMSSD" as const,
      value: 52,
      unit: "ms",
      measuredAt,
      externalId: "readiness:2026-06-10:hrv",
    },
  ];

  it("emits only rows returned by the insert statement and updates a raced duplicate", async () => {
    const inserted = {
      id: "new-1",
      type: "RECOVERY_SCORE",
      measuredAt,
      externalId: readings[0].externalId,
    };
    reconcileMock
      .mockResolvedValueOnce({ status: "inserted", row: inserted })
      .mockResolvedValueOnce({
        status: "updated",
        row: {
          id: "existing-2",
          type: "HRV_RMSSD",
          measuredAt,
          externalId: readings[1].externalId,
        },
      });
    const onInserted = vi.fn();

    expect(await upsertOuraMeasurements("u1", readings, { onInserted })).toBe(
      2,
    );

    expect(onInserted).toHaveBeenCalledWith([inserted]);
    expect(emitArrivalMock).toHaveBeenCalledWith("u1", [inserted], "oura");
    expect(reconcileMock.mock.calls[1]![1]).toMatchObject({
      userId: "u1",
      type: "HRV_RMSSD",
      source: "OURA",
      externalId: readings[1].externalId,
    });
  });

  it("does not pre-probe and still emits a genuine insert", async () => {
    findManyMock.mockRejectedValue(new Error("probe unavailable"));
    const inserted = {
      id: "new-1",
      type: "RECOVERY_SCORE",
      measuredAt,
      externalId: readings[0].externalId,
    };
    reconcileMock.mockResolvedValueOnce({ status: "inserted", row: inserted });

    await upsertOuraMeasurements("u1", [readings[0]]);

    expect(findManyMock).not.toHaveBeenCalled();
    expect(emitArrivalMock).toHaveBeenCalledWith("u1", [inserted], "oura");
  });
});
