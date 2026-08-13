/**
 * Unit suite for `GET /api/workouts/{id}` — single-workout detail.
 *
 * v1.4.32 — paired with the list endpoint so the iOS detail screen +
 * the `/insights/workouts/[id]` web page consume one envelope per
 * workout. The test pins:
 *   - 200 + iOS-contract field names for a row the caller owns;
 *   - 401 without a session;
 *   - 404 (existence-channel sealed) when the row belongs to another
 *     user;
 *   - 404 when no row exists;
 *   - `canonicalId` resolves to the cluster winner — the requested id
 *     when the row is the canonical pick, the winner id when it is a
 *     non-canonical twin;
 *   - the optional `route` field flows through GeoJSON geometry when a
 *     `WorkoutRoute` row is attached, and is null when missing;
 *   - `aiInsight` is a pure READ: it serves a stored paragraph when one
 *     exists, null when none does, and never generates one;
 *   - `dayKey` dates the session in the user's timezone, so a session that
 *     starts late in the UTC evening lands on the local day the person
 *     actually trained on.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { _resetCryptoCacheForTests } from "@/lib/crypto";

vi.mock("@/lib/db", () => ({
  prisma: {
    workout: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    measurement: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

vi.mock("@/lib/modules/gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/modules/gate")>();
  return {
    ...actual,
    resolveModuleMap: vi.fn(async () => ({})),
    requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
    isModuleEnabled: vi.fn(async () => true),
  };
});

import { GET } from "../[id]/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled, requireModuleEnabled } from "@/lib/modules/gate";
import { invalidateUserTimezone } from "@/lib/tz/resolver";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/workouts/w-1", {
    method: "GET",
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * Session day, ten days before the test run. The detail route's HR-curve
 * enrichment only reaches the pulse-window fallback inside the 90-day
 * dense-intraday retention horizon (`DENSE_INTRADAY_RETENTION_DAYS`), so a
 * fixed calendar day silently ages out of that branch and leaves the
 * fallback assertions green without exercising it.
 */
const SESSION_DAY = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

const BASE_ROW = {
  id: "w-1",
  userId: "user-1",
  sportType: "RUNNING",
  startedAt: new Date(`${SESSION_DAY}T07:00:00Z`),
  endedAt: new Date(`${SESSION_DAY}T07:30:00Z`),
  durationSec: 1800,
  totalDistanceM: 5000,
  totalEnergyKcal: 320,
  avgHeartRate: 145,
  maxHeartRate: 170,
  minHeartRate: 110,
  stepCount: 5800,
  elevationM: 12.5,
  pauseDurationSec: null,
  source: "APPLE_HEALTH" as const,
  externalId: "ext-w-1",
  externalSourceVersion: null,
  metadata: { hkVersion: "1" },
  createdAt: new Date(`${SESSION_DAY}T07:30:00Z`),
  updatedAt: new Date(`${SESSION_DAY}T07:30:00Z`),
  route: null,
  insight: null,
};

describe("GET /api/workouts/{id}", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      sourcePriorityJson: null,
      dateOfBirth: null,
    } as never);
    // #67 — the enrichment reads: the HR-curve pulse-window fallback
    // (`measurement.findMany`) and the sport-context average (a SECOND
    // `workout.findMany`). Default both to empty; each test's
    // `mockResolvedValueOnce` still wins for the cluster call.
    vi.mocked(prisma.workout.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    // clearAllMocks wipes the factory default; re-seed the gate to pass.
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: true,
    } as never);
    vi.mocked(isModuleEnabled).mockResolvedValue(true);
    // The timezone resolver caches per user for 60 s in process; drop the
    // entry so a test that pins a zone is not served the previous one.
    invalidateUserTimezone(SESSION_OK.user.id);
  });

  it("returns the workout with iOS-contract field names", async () => {
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce(
      BASE_ROW as never,
    );
    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      {
        id: "w-1",
        source: "APPLE_HEALTH",
        startedAt: BASE_ROW.startedAt,
        sportType: "RUNNING",
      },
    ] as never);

    const res = await GET(makeRequest(), makeParams("w-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.id).toBe("w-1");
    expect(body.data.distanceM).toBe(5000);
    expect(body.data.activeEnergyKcal).toBe(320);
    expect(body.data.avgHr).toBe(145);
    expect(body.data.maxHr).toBe(170);
    expect(body.data.canonicalId).toBe("w-1");
    expect(body.data.route).toBeNull();
    // Nothing older on record: absence, not a link to nowhere.
    expect(body.data.previousWorkoutId).toBeNull();
  });

  it("points previousWorkoutId at the canonical session before this one", async () => {
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce(
      BASE_ROW as never,
    );
    vi.mocked(prisma.workout.findMany)
      // 1) the deep-link cluster
      .mockResolvedValueOnce([
        {
          id: "w-1",
          source: "APPLE_HEALTH",
          startedAt: BASE_ROW.startedAt,
          sportType: "RUNNING",
        },
      ] as never)
      // 2) the sport-context baseline
      .mockResolvedValueOnce([] as never)
      // 3) the older sessions, newest first
      .mockResolvedValueOnce([
        {
          id: "w-0",
          source: "APPLE_HEALTH",
          startedAt: new Date("2026-05-13T07:00:00Z"),
          sportType: "RUNNING",
          durationSec: 1800,
          avgHeartRate: null,
          maxHeartRate: null,
          metadata: null,
        },
        // The same session as seen by the second watch. It must never win
        // the link — the list would never show it.
        {
          id: "w-0-twin",
          source: "WITHINGS",
          startedAt: new Date("2026-05-13T07:01:00Z"),
          sportType: "RUNNING",
          durationSec: 1800,
          avgHeartRate: null,
          maxHeartRate: null,
          metadata: null,
        },
        {
          id: "w-older",
          source: "APPLE_HEALTH",
          startedAt: new Date("2026-05-10T07:00:00Z"),
          sportType: "RUNNING",
          durationSec: 1800,
          avgHeartRate: null,
          maxHeartRate: null,
          metadata: null,
        },
      ] as never);

    const res = await GET(makeRequest(), makeParams("w-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.previousWorkoutId).toBe("w-0");
  });

  it("dates the session by the user's timezone, not by UTC", async () => {
    // 20:00 UTC is already the NEXT calendar day in Auckland. A client that
    // sliced the ISO timestamp would read the session's UTC day and pull the wrong
    // day's pulse, sleep and mood around the session.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      sourcePriorityJson: null,
      dateOfBirth: null,
      timezone: "Pacific/Auckland",
    } as never);
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce({
      ...BASE_ROW,
      startedAt: new Date(`${SESSION_DAY}T20:00:00Z`),
      endedAt: new Date(`${SESSION_DAY}T20:30:00Z`),
    } as never);
    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      {
        id: "w-1",
        source: "APPLE_HEALTH",
        startedAt: new Date(`${SESSION_DAY}T20:00:00Z`),
        sportType: "RUNNING",
      },
    ] as never);

    const res = await GET(makeRequest(), makeParams("w-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    const nextLocalDay = new Date(
      new Date(`${SESSION_DAY}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);
    expect(body.data.dayKey).toBe(nextLocalDay);
  });

  it("enriches the Apple winner with only matched WHOOP HR and zones", async () => {
    const routeGeometry = {
      type: "LineString",
      coordinates: [
        [11.0, 49.0],
        [11.01, 49.01],
      ],
    };
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce({
      ...BASE_ROW,
      avgHeartRate: null,
      maxHeartRate: null,
      metadata: { hkVersion: "1", owner: "apple" },
      route: {
        id: "wr-apple",
        geometry: routeGeometry,
        sampleTimestamps: null,
        createdAt: BASE_ROW.createdAt,
      },
    } as never);
    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      {
        id: "w-1",
        source: "APPLE_HEALTH",
        startedAt: BASE_ROW.startedAt,
        sportType: "RUNNING",
        avgHeartRate: null,
        maxHeartRate: null,
        metadata: { hkVersion: "1", owner: "apple" },
      },
      {
        id: "w-whoop",
        source: "WHOOP",
        startedAt: new Date(BASE_ROW.startedAt.getTime() + 30_000),
        sportType: "RUNNING",
        avgHeartRate: 148,
        maxHeartRate: 181,
        metadata: {
          zoneDurations: {
            zone_one_milli: 60_000,
            zone_two_milli: 300_000,
          },
          whoopWorkoutStrain: 12.3,
        },
      },
    ] as never);

    const res = await GET(makeRequest(), makeParams("w-1"));
    const body = await res.json();

    expect(body.data).toMatchObject({
      id: "w-1",
      source: "APPLE_HEALTH",
      canonicalId: "w-1",
      avgHr: 148,
      maxHr: 181,
      route: { geometry: routeGeometry },
      metadata: { hkVersion: "1", owner: "apple" },
    });
    expect(body.data.metadata).not.toHaveProperty("whoopWorkoutStrain");
    expect(body.data.metadata).not.toHaveProperty("zoneDurations");
    expect(body.data.zones.model).toBe("whoop");
    expect(body.data.hrSeries).toBeNull();
  });

  it("does not overwrite the canonical winner's existing HR values", async () => {
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce(
      BASE_ROW as never,
    );
    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      {
        id: "w-1",
        source: "APPLE_HEALTH",
        startedAt: BASE_ROW.startedAt,
        sportType: "RUNNING",
        avgHeartRate: BASE_ROW.avgHeartRate,
        maxHeartRate: BASE_ROW.maxHeartRate,
        metadata: BASE_ROW.metadata,
      },
      {
        id: "w-whoop",
        source: "WHOOP",
        startedAt: new Date(BASE_ROW.startedAt.getTime() + 30_000),
        sportType: "RUNNING",
        avgHeartRate: 155,
        maxHeartRate: 190,
        metadata: null,
      },
    ] as never);

    const res = await GET(makeRequest(), makeParams("w-1"));
    const body = await res.json();

    expect(body.data.avgHr).toBe(145);
    expect(body.data.maxHr).toBe(170);
  });

  it("returns 401 without a session", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const res = await GET(makeRequest(), makeParams("w-1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 module.disabled when the workouts module is off", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValueOnce({
      enabled: false,
      response: new Response(
        JSON.stringify({ data: null, error: "Module disabled" }),
        { status: 403 },
      ),
    } as never);
    const res = await GET(makeRequest(), makeParams("w-1"));
    expect(res.status).toBe(403);
    // The detail query never runs once the gate refuses.
    expect(prisma.workout.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 when the row belongs to another user", async () => {
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce({
      ...BASE_ROW,
      userId: "user-2",
    } as never);

    const res = await GET(makeRequest(), makeParams("w-1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when no row exists", async () => {
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce(null);
    const res = await GET(makeRequest(), makeParams("w-1"));
    expect(res.status).toBe(404);
  });

  it("resolves canonicalId to the Apple Health twin when the requested row is the Withings sibling", async () => {
    // Same 5-minute slot + sportType, but the caller asked for the
    // Withings row. The picker's default ladder makes Apple Health win
    // the cluster, so canonicalId points at the Apple row.
    const withingsRow = {
      ...BASE_ROW,
      id: "w-withings",
      source: "WITHINGS" as const,
      externalId: "withings-1",
    };
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce(
      withingsRow as never,
    );
    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      {
        id: "w-apple",
        source: "APPLE_HEALTH",
        startedAt: BASE_ROW.startedAt,
        sportType: "RUNNING",
      },
      {
        id: "w-withings",
        source: "WITHINGS",
        startedAt: BASE_ROW.startedAt,
        sportType: "RUNNING",
      },
    ] as never);

    const res = await GET(makeRequest(), makeParams("w-withings"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.id).toBe("w-withings");
    expect(body.data.canonicalId).toBe("w-apple");
  });

  it("adds the #67 enrichment fields and strips raw blobs under compact=1", async () => {
    const startMs = BASE_ROW.startedAt.getTime();
    const storedSamples = Array.from({ length: 40 }, (_, i) => ({
      t: new Date(startMs + i * 45_000).toISOString(),
      hr: 140 + (i % 6),
    }));
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce({
      ...BASE_ROW,
      // WHOOP device zones win → zones render even without profile age.
      metadata: {
        zoneDurations: {
          zone_one_milli: 60_000,
          zone_two_milli: 300_000,
          zone_three_milli: 600_000,
          zone_four_milli: 200_000,
          zone_five_milli: 40_000,
        },
      },
      route: {
        id: "wr-1",
        geometry: {
          type: "LineString",
          coordinates: [
            [11, 49],
            [11.01, 49.01],
          ],
        },
        sampleTimestamps: [
          `${SESSION_DAY}T07:00:00Z`,
          `${SESSION_DAY}T07:01:00Z`,
        ],
        createdAt: BASE_ROW.createdAt,
      },
      samples: { sampleCount: storedSamples.length, samples: storedSamples },
    } as never);
    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      {
        id: "w-1",
        source: "APPLE_HEALTH",
        startedAt: BASE_ROW.startedAt,
        sportType: "RUNNING",
      },
    ] as never);

    const res = await GET(
      new NextRequest("http://localhost/api/workouts/w-1?compact=1", {
        method: "GET",
      }),
      makeParams("w-1"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    // Stored series wins → provenance is the native workout series.
    expect(body.data.hrSeries.source).toBe("workout_series");
    expect(body.data.hrSeries.points.length).toBeGreaterThanOrEqual(2);
    // WHOOP device zones.
    expect(body.data.zones.model).toBe("whoop");
    // Additive keys present; reserved seam is null.
    expect(body.data).toHaveProperty("splits");
    expect(body.data).toHaveProperty("sportContext");
    expect(body.data.aiInsight).toBeNull();
    // compact=1 drops the raw blobs but keeps count + geometry.
    expect(body.data.samples.sampleCount).toBe(40);
    expect(body.data.samples.samples).toBeNull();
    expect(body.data.route.geometry).not.toBeNull();
    expect(body.data.route.sampleTimestamps).toBeNull();
  });

  it("exposes the WorkoutRoute geometry when present", async () => {
    const routeGeometry = {
      type: "LineString",
      coordinates: [
        [11.0, 49.0],
        [11.01, 49.01],
      ],
    };
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce({
      ...BASE_ROW,
      route: {
        id: "wr-1",
        geometry: routeGeometry,
        sampleTimestamps: [
          `${SESSION_DAY}T07:00:00Z`,
          `${SESSION_DAY}T07:01:00Z`,
        ],
        createdAt: BASE_ROW.createdAt,
      },
    } as never);
    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      {
        id: "w-1",
        source: "APPLE_HEALTH",
        startedAt: BASE_ROW.startedAt,
        sportType: "RUNNING",
      },
    ] as never);

    const res = await GET(makeRequest(), makeParams("w-1"));
    const body = await res.json();

    expect(body.data.route).not.toBeNull();
    expect(body.data.route.geometry).toEqual(routeGeometry);
    expect(body.data.route.sampleTimestamps).toEqual([
      `${SESSION_DAY}T07:00:00Z`,
      `${SESSION_DAY}T07:01:00Z`,
    ]);
  });
});

/**
 * The Activity-Insight read.
 *
 * The load-bearing property is what is ABSENT: this route has no enqueue, no
 * provider resolution and no fallback. A workout with no stored row serves null
 * and the page renders nothing — which is every workout that predates the
 * feature, every re-synced one, and every one on a provider-less install.
 */
describe("GET /api/workouts/{id} — aiInsight", () => {
  // A throwaway test key. The route decrypts a stored paragraph, so the suite
  // needs a configured cipher; `_resetCryptoCacheForTests` keeps the stubbed
  // key from leaking into the neighbouring describes.
  const TEST_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    _resetCryptoCacheForTests();
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      sourcePriorityJson: null,
      dateOfBirth: null,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.workout.findMany).mockResolvedValue([
      {
        id: "w-1",
        source: "APPLE_HEALTH",
        startedAt: BASE_ROW.startedAt,
        sportType: "RUNNING",
      },
    ] as never);
  });

  async function get() {
    return GET(
      new NextRequest("http://localhost/api/workouts/w-1?compact=1", {
        method: "GET",
      }),
      makeParams("w-1"),
    );
  }

  it("serves null when the workout has no stored paragraph", async () => {
    vi.mocked(prisma.workout.findUnique).mockResolvedValue({
      ...BASE_ROW,
      insight: null,
    } as never);

    const body = await (await get()).json();
    expect(body.data.aiInsight).toBeNull();
  });

  it("serves the decrypted paragraph when one exists", async () => {
    const { encryptToBytes } = await import("@/lib/ai/coach/bytes-codec");
    const generatedAt = new Date(`${SESSION_DAY}T07:35:00Z`);
    vi.mocked(prisma.workout.findUnique).mockResolvedValue({
      ...BASE_ROW,
      insight: {
        paragraphEncrypted: encryptToBytes("A steady, aerobic-leaning run."),
        generatedAt,
      },
    } as never);

    const body = await (await get()).json();
    expect(body.data.aiInsight).toEqual({
      paragraph: "A steady, aerobic-leaning run.",
      generatedAt: generatedAt.toISOString(),
    });
  });

  it("does not read or expose the stored paragraph when Insights is disabled", async () => {
    vi.mocked(isModuleEnabled).mockResolvedValueOnce(false);
    vi.mocked(prisma.workout.findUnique).mockResolvedValue({
      ...BASE_ROW,
      insight: {
        paragraphEncrypted: new Uint8Array([1, 2, 3]),
        generatedAt: new Date(`${SESSION_DAY}T07:35:00Z`),
      },
    } as never);

    const body = await (await get()).json();
    expect(body.data.aiInsight).toBeNull();
    expect(prisma.workout.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ insight: false }),
      }),
    );
  });

  it("degrades to no card rather than failing the page on an undecryptable row", async () => {
    // `decrypt` is fail-closed by design. A key rotated away must not turn the
    // whole workout-detail page into a 500 over a garnish field.
    vi.mocked(prisma.workout.findUnique).mockResolvedValue({
      ...BASE_ROW,
      insight: {
        paragraphEncrypted: new Uint8Array([0, 1, 2, 3]),
        generatedAt: new Date(`${SESSION_DAY}T07:35:00Z`),
      },
    } as never);

    const res = await get();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.aiInsight).toBeNull();
    // The rest of the payload is untouched — the failure is scoped to the field.
    expect(body.data.id).toBe("w-1");
    expect(body.data.durationSec).toBe(1800);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetCryptoCacheForTests();
  });
});
