import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    // v1.18.11 (P6) — the input gate / fingerprint probe salient inputs.
    measurement: { groupBy: vi.fn() },
    moodEntry: { aggregate: vi.fn() },
    customMetric: { findMany: vi.fn() },
  },
}));

const hasUsableStatusProvider = vi.fn();
const statusConsentBlocksGeneration = vi.fn();
vi.mock("@/lib/insights/status-provider", () => ({
  hasUsableStatusProvider: (...a: unknown[]) => hasUsableStatusProvider(...a),
  statusConsentBlocksGeneration: (...a: unknown[]) =>
    statusConsentBlocksGeneration(...a),
}));

const enqueueStatusGeneration = vi.fn();
vi.mock("@/lib/jobs/insight-status-generate-shared", () => ({
  enqueueStatusGeneration: (...a: unknown[]) => enqueueStatusGeneration(...a),
}));

import { prisma } from "@/lib/db";
import {
  computeStatusInputFingerprint,
  gateUnchangedStatusInput,
  isTimeoutStub,
  readFreshStatusText,
  refreshUnchangedStatusInsight,
  resolveReadOnlyStatusMiss,
} from "../status-cache";

const TODAY = "2026-05-31";

function cacheRow(details: Record<string, unknown>, createdAt = new Date()) {
  return { createdAt, details: JSON.stringify(details) };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.customMetric.findMany).mockResolvedValue([] as never);
});

describe("isTimeoutStub", () => {
  it("flags the timeout-stub model marker", () => {
    expect(isTimeoutStub({ model: "timeout-stub" })).toBe(true);
  });

  it("flags the timeout:true marker", () => {
    expect(isTimeoutStub({ timeout: true })).toBe(true);
  });

  it("does not flag a real assessment", () => {
    expect(isTimeoutStub({ model: "gpt-4o-mini", timeout: false })).toBe(false);
    expect(isTimeoutStub({})).toBe(false);
  });
});

describe("readFreshStatusText", () => {
  it("returns today's real assessment text", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({
        dateKey: TODAY,
        text: "Your weight trend is stable.",
        model: "gpt-4o-mini",
      }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit?.text).toBe("Your weight trend is stable.");
  });

  it("skips a timeout-stub row keyed to today", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({
        dateKey: TODAY,
        text: "Generic fallback advice.",
        model: "timeout-stub",
        timeout: true,
      }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit).toBeNull();
  });

  it("skips a stale-day row", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({ dateKey: "2026-05-30", text: "Yesterday." }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit).toBeNull();
  });

  it("skips an empty-text row", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({ dateKey: TODAY, text: "   " }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit).toBeNull();
  });

  it("does not read the cache under force", async () => {
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: true,
    });
    expect(hit).toBeNull();
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
  });

  it("treats a malformed payload as a miss", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue({
      createdAt: new Date(),
      details: "{not json",
    } as never);
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit).toBeNull();
  });
});

describe("resolveReadOnlyStatusMiss", () => {
  beforeEach(() => {
    // Default: no prior assessment to serve stale (readLastGoodStatusText).
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([] as never);
  });

  it("returns no-provider without enqueuing when the user has no provider", async () => {
    hasUsableStatusProvider.mockResolvedValue(false);
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "weight",
      locale: "en",
    });
    expect(outcome.kind).toBe("no-provider");
    expect(enqueueStatusGeneration).not.toHaveBeenCalled();
  });

  it("enqueues generation and returns preparing on a clean miss", async () => {
    hasUsableStatusProvider.mockResolvedValue(true);
    // No negative stub present.
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null as never);
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "pulse",
      locale: "de",
    });
    expect(outcome.kind).toBe("preparing");
    // No last-good text to show, so nothing to revalidate against — the card
    // polls on `preparing` alone.
    expect(outcome).toEqual({
      kind: "preparing",
      lastGood: null,
      revalidating: false,
    });
    expect(enqueueStatusGeneration).toHaveBeenCalledWith({
      userId: "u1",
      metric: "pulse",
      locale: "de",
    });
  });

  it("serves the last good assessment stale-while-revalidate on a clean miss", async () => {
    hasUsableStatusProvider.mockResolvedValue(true);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null as never);
    // A prior (e.g. yesterday's) real assessment is on record.
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
      cacheRow(
        {
          dateKey: "2026-05-30",
          text: "Steady upward trend.",
          model: "gpt-4o-mini",
        },
        new Date("2026-05-30T04:30:00.000Z"),
      ),
    ] as never);
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "weight",
      locale: "en",
    });
    expect(outcome.kind).toBe("preparing");
    if (outcome.kind !== "preparing") throw new Error("expected preparing");
    expect(outcome.lastGood?.text).toBe("Steady upward trend.");
    // v1.9.0 — stale text served AND a refresh enqueued → revalidating so the
    // open card keeps polling until the fresh assessment lands.
    expect(outcome.revalidating).toBe(true);
    // A refresh is still enqueued behind the stale serve.
    expect(enqueueStatusGeneration).toHaveBeenCalledTimes(1);
  });

  it("suppresses re-enqueue while a fresh timeout stub exists", async () => {
    hasUsableStatusProvider.mockResolvedValue(true);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({
        dateKey: TODAY,
        timeout: true,
        model: "timeout-stub",
        retryAt: new Date(Date.now() + 60_000).toISOString(),
      }) as never,
    );
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "mood",
      locale: "en",
    });
    expect(outcome.kind).toBe("preparing");
    if (outcome.kind !== "preparing") throw new Error("expected preparing");
    // No enqueue on the suppressed branch → nothing in flight to revalidate.
    expect(outcome.revalidating).toBe(false);
    expect(enqueueStatusGeneration).not.toHaveBeenCalled();
  });

  it("re-enqueues once the negative stub's retryAt has passed", async () => {
    hasUsableStatusProvider.mockResolvedValue(true);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({
        dateKey: TODAY,
        timeout: true,
        model: "timeout-stub",
        retryAt: new Date(Date.now() - 60_000).toISOString(),
      }) as never,
    );
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "bmi",
      locale: "de",
    });
    expect(outcome.kind).toBe("preparing");
    expect(enqueueStatusGeneration).toHaveBeenCalledTimes(1);
  });
});

describe("refreshUnchangedStatusInsight (v1.16.8)", () => {
  const HASH = "a".repeat(64);

  beforeEach(() => {
    // Default: consent does not block (BYOK / consented chains).
    statusConsentBlocksGeneration.mockResolvedValue(false);
  });

  it("misses (and writes nothing) when the server-managed consent is revoked, even on a hash match", async () => {
    statusConsentBlocksGeneration.mockResolvedValue(true);
    const hit = await refreshUnchangedStatusInsight({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      snapshotHash: HASH,
    });
    expect(hit).toBeNull();
    // The gate must not even read the cache row — a revoked consent can
    // never re-stamp old AI text as today's assessment.
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(statusConsentBlocksGeneration).toHaveBeenCalledWith(
      "u1",
      "insights",
    );
  });

  it("re-persists the row under today's dateKey and returns the text on a hash match", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({
        dateKey: "2026-05-30",
        locale: "en",
        text: "Stable weight, no concerns.",
        providerType: "openai",
        model: "gpt-4o-mini",
        tokensUsed: 321,
        snapshotHash: HASH,
      }) as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date("2026-05-31T04:30:00.000Z"),
    } as never);

    const hit = await refreshUnchangedStatusInsight({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      snapshotHash: HASH,
    });

    expect(hit?.text).toBe("Stable weight, no concerns.");
    expect(hit?.updatedAt).toBe("2026-05-31T04:30:00.000Z");
    // The refresh row carries the same payload re-keyed to today, so the
    // read path and the ingest debounce both see a current assessment.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.auditLog.create).mock.calls[0][0] as {
      data: { userId: string; action: string; details: string };
    };
    expect(arg.data.userId).toBe("u1");
    expect(arg.data.action).toBe("insights.weight-status.en");
    const details = JSON.parse(arg.data.details) as Record<string, unknown>;
    expect(details.dateKey).toBe(TODAY);
    expect(details.text).toBe("Stable weight, no concerns.");
    expect(details.snapshotHash).toBe(HASH);
  });

  it("misses (and writes nothing) when the stored hash differs", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({
        dateKey: "2026-05-30",
        text: "Older text.",
        model: "gpt-4o-mini",
        snapshotHash: "b".repeat(64),
      }) as never,
    );
    const hit = await refreshUnchangedStatusInsight({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      snapshotHash: HASH,
    });
    expect(hit).toBeNull();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("misses when the latest row carries no hash (pre-gate rows)", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({
        dateKey: "2026-05-30",
        text: "Older text.",
        model: "gpt-4o-mini",
      }) as never,
    );
    const hit = await refreshUnchangedStatusInsight({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      snapshotHash: HASH,
    });
    expect(hit).toBeNull();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("never refreshes off a timeout stub, even with a matching hash", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({
        dateKey: "2026-05-30",
        text: "Generic fallback advice.",
        model: "timeout-stub",
        timeout: true,
        snapshotHash: HASH,
      }) as never,
    );
    const hit = await refreshUnchangedStatusInsight({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      snapshotHash: HASH,
    });
    expect(hit).toBeNull();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("misses on no prior row and on malformed payloads", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValueOnce(null as never);
    expect(
      await refreshUnchangedStatusInsight({
        userId: "u1",
        cacheAction: "insights.weight-status.en",
        todayKey: TODAY,
        snapshotHash: HASH,
      }),
    ).toBeNull();

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValueOnce({
      details: "{not json",
    } as never);
    expect(
      await refreshUnchangedStatusInsight({
        userId: "u1",
        cacheAction: "insights.weight-status.en",
        todayKey: TODAY,
        snapshotHash: HASH,
      }),
    ).toBeNull();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("computeStatusInputFingerprint (v1.18.11 P6)", () => {
  beforeEach(() => {
    statusConsentBlocksGeneration.mockResolvedValue(false);
  });

  it("is stable across group order and flips when a count or newest moves", async () => {
    const t0 = new Date("2026-05-30T08:00:00.000Z");
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      { type: "WEIGHT", _count: { _all: 10 }, _max: { measuredAt: t0 } },
      {
        type: "BLOOD_PRESSURE_SYS",
        _count: { _all: 3 },
        _max: { measuredAt: t0 },
      },
    ] as never);
    const a = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT", "BLOOD_PRESSURE_SYS"],
    });

    // Same data, reversed group order → identical fingerprint.
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      {
        type: "BLOOD_PRESSURE_SYS",
        _count: { _all: 3 },
        _max: { measuredAt: t0 },
      },
      { type: "WEIGHT", _count: { _all: 10 }, _max: { measuredAt: t0 } },
    ] as never);
    const b = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT", "BLOOD_PRESSURE_SYS"],
    });
    expect(b).toBe(a);

    // One more reading → count moves → fingerprint flips.
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      { type: "WEIGHT", _count: { _all: 11 }, _max: { measuredAt: t0 } },
      {
        type: "BLOOD_PRESSURE_SYS",
        _count: { _all: 3 },
        _max: { measuredAt: t0 },
      },
    ] as never);
    const c = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT", "BLOOD_PRESSURE_SYS"],
    });
    expect(c).not.toBe(a);
  });

  it("flips when a correlation-discovery channel moves (P6-tighten)", async () => {
    const t0 = new Date("2026-05-30T08:00:00.000Z");
    // The card's own metric (WEIGHT) is steady across both probes; only a
    // discovery BEHAVIOUR channel (steps) gains rows. Without the channel
    // coverage the gate would re-stamp the stale assessment and a newly
    // discoverable "steps → next-day weight" relation would never surface.
    const weightOnly = [
      { type: "WEIGHT", _count: { _all: 10 }, _max: { measuredAt: t0 } },
    ];
    vi.mocked(prisma.measurement.groupBy).mockResolvedValueOnce(
      weightOnly as never,
    );
    const before = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
      includeCorrelationChannels: true,
    });

    // A new ACTIVITY_STEPS reading (a discovery channel, NOT the card's own
    // type) appears — the grouped probe now returns it.
    vi.mocked(prisma.measurement.groupBy).mockResolvedValueOnce([
      ...weightOnly,
      {
        type: "ACTIVITY_STEPS",
        _count: { _all: 30 },
        _max: { measuredAt: t0 },
      },
    ] as never);
    const after = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
      includeCorrelationChannels: true,
    });
    expect(after).not.toBe(before);
  });

  it("folds opted-in custom metric configuration and entries into the fingerprint", async () => {
    const t0 = new Date("2026-05-30T08:00:00.000Z");
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.customMetric.findMany)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        {
          id: "custom-1",
          unit: "kg",
          updatedAt: t0,
          _count: { entries: 1 },
          entries: [{ measuredAt: t0, unit: "kg" }],
        },
      ] as never);

    const before = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
      includeCorrelationChannels: true,
    });
    const after = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
      includeCorrelationChannels: true,
    });

    expect(after).not.toBe(before);
    expect(prisma.customMetric.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          userId: "u1",
          deletedAt: null,
          correlationEnabled: true,
        },
      }),
    );
  });

  it("widens the grouped query by the discovery channels only when asked", async () => {
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([] as never);
    await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
    });
    const narrow = vi.mocked(prisma.measurement.groupBy).mock.calls[0][0] as {
      where: { type: { in: string[] } };
    };
    // No channel widening — exactly the card's own types.
    expect(narrow.where.type.in).toEqual(["WEIGHT"]);

    vi.mocked(prisma.measurement.groupBy).mockClear();
    await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
      includeCorrelationChannels: true,
    });
    const wide = vi.mocked(prisma.measurement.groupBy).mock.calls[0][0] as {
      where: { type: { in: string[] } };
    };
    // The card's own type is present exactly once (de-duped against the
    // discovery channel set, which also carries WEIGHT as an outcome).
    expect(wide.where.type.in.filter((t) => t === "WEIGHT")).toHaveLength(1);
    // A behaviour channel the card never reads on its own is now folded in.
    expect(wide.where.type.in).toContain("ACTIVITY_STEPS");
    expect(wide.where.type.in).toContain("SLEEP_DURATION");
    // MOOD is mood-entry backed, not a measurement type — never in the IN set.
    expect(wide.where.type.in).not.toContain("MOOD");
  });

  it("folds mood and extra inputs into the hash when requested", async () => {
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      {
        type: "WEIGHT",
        _count: { _all: 5 },
        _max: { measuredAt: new Date("2026-05-30T08:00:00.000Z") },
      },
    ] as never);
    vi.mocked(prisma.moodEntry.aggregate).mockResolvedValue({
      _count: { _all: 2 },
      _max: { moodLoggedAt: new Date("2026-05-29T20:00:00.000Z") },
    } as never);

    const withMood = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
      includeMood: true,
    });
    const heightChanged = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
      includeMood: true,
      extra: { heightCm: 180 },
    });
    expect(heightChanged).not.toBe(withMood);
    // moodEntry.aggregate is only queried when includeMood is set.
    await computeStatusInputFingerprint({ userId: "u1", types: ["WEIGHT"] });
    expect(prisma.moodEntry.aggregate).toHaveBeenCalledTimes(2);
  });
});

describe("gateUnchangedStatusInput (v1.18.11 P6)", () => {
  const INPUT = "b".repeat(64);

  beforeEach(() => {
    statusConsentBlocksGeneration.mockResolvedValue(false);
  });

  it("re-stamps the cached text and skips the build on a matching input hash", async () => {
    const created = new Date("2026-05-31T02:00:00.000Z");
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({
        dateKey: "2026-05-30",
        text: "Stable weight.",
        model: "gpt-4o-mini",
        inputHash: INPUT,
        snapshotHash: "c".repeat(64),
      }) as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: created,
    } as never);

    const hit = await gateUnchangedStatusInput({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      inputHash: INPUT,
      force: false,
    });
    expect(hit?.text).toBe("Stable weight.");
    const persisted = JSON.parse(
      (
        vi.mocked(prisma.auditLog.create).mock.calls[0][0] as {
          data: { details: string };
        }
      ).data.details,
    ) as { dateKey: string; inputHash: string; snapshotHash: string };
    expect(persisted.dateKey).toBe(TODAY);
    // The prior fingerprints are preserved so the next day's gates match.
    expect(persisted.inputHash).toBe(INPUT);
    expect(persisted.snapshotHash).toBe("c".repeat(64));
  });

  it("misses on a differing or missing input hash (caller builds)", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(
      cacheRow({
        dateKey: "2026-05-30",
        text: "Stable weight.",
        model: "gpt-4o-mini",
        // no inputHash on the row
      }) as never,
    );
    expect(
      await gateUnchangedStatusInput({
        userId: "u1",
        cacheAction: "insights.weight-status.en",
        todayKey: TODAY,
        inputHash: INPUT,
        force: false,
      }),
    ).toBeNull();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("misses on a forced run without touching the cache", async () => {
    expect(
      await gateUnchangedStatusInput({
        userId: "u1",
        cacheAction: "insights.weight-status.en",
        todayKey: TODAY,
        inputHash: INPUT,
        force: true,
      }),
    ).toBeNull();
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
  });

  it("misses when the server-managed consent gate would block (no stale re-date)", async () => {
    statusConsentBlocksGeneration.mockResolvedValue(true);
    expect(
      await gateUnchangedStatusInput({
        userId: "u1",
        cacheAction: "insights.weight-status.en",
        todayKey: TODAY,
        inputHash: INPUT,
        force: false,
      }),
    ).toBeNull();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
