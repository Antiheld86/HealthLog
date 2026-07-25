import { describe, it, expect, vi, beforeEach } from "vitest";

const { measurement, moodEntry, $transaction } = vi.hoisted(() => ({
  measurement: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  moodEntry: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { measurement, moodEntry, $transaction },
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMeasurements: vi.fn(),
  invalidateUserMood: vi.fn(),
}));

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rollups/mood-rollups", () => ({
  recomputeMoodBucketsForEntry: vi.fn().mockResolvedValue(undefined),
}));

const auditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/auth/audit", () => ({
  auditLog: (...args: unknown[]) => auditLog(...args),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({ addMeta: vi.fn() }),
}));

import { logMcpMeasurement, logMcpMood, logMcpBloodPressure } from "../writes";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";

beforeEach(() => {
  vi.clearAllMocks();
  measurement.findUnique.mockResolvedValue(null);
  measurement.create.mockResolvedValue({ id: "m-1" });
  $transaction.mockResolvedValue([{ id: "s-1" }, { id: "d-1" }]);
  moodEntry.findUnique.mockResolvedValue(null);
  moodEntry.create.mockResolvedValue({
    date: "2026-06-27",
    mood: "GUT",
    note: null,
    tags: [],
  });
});

describe("logMcpMeasurement", () => {
  it("writes one row with source MCP for a capturable type", async () => {
    const result = await logMcpMeasurement({
      userId: "u-1",
      type: "WEIGHT",
      value: 80,
      idempotencyKey: "key-1",
    });

    expect(result.status).toBe("written");
    expect(measurement.create).toHaveBeenCalledTimes(1);
    const data = measurement.create.mock.calls[0][0].data;
    expect(data.source).toBe("MCP");
    expect(data.userId).toBe("u-1");
    expect(data.type).toBe("WEIGHT");
    expect(data.value).toBe(80);
    expect(data.unit).toBe("kg");
    // externalId is namespaced + hashed (never the raw key).
    expect(data.externalId).toMatch(/^mcp:measure:[0-9a-f]{64}$/);
    expect(data.externalId).not.toContain("key-1");
    expect(invalidateUserMeasurements).toHaveBeenCalledWith("u-1", {
      evict: true,
    });
    expect(auditLog).toHaveBeenCalledWith(
      "mcp.write.measurement",
      expect.objectContaining({ userId: "u-1" }),
    );
  });

  it("converts a lb unit hint to canonical kg before writing", async () => {
    const result = await logMcpMeasurement({
      userId: "u-1",
      type: "WEIGHT",
      value: 210,
      unit: "lb",
      idempotencyKey: "key-lb",
    });

    expect(result.status).toBe("written");
    const data = measurement.create.mock.calls[0][0].data;
    expect(data.unit).toBe("kg");
    // 210 lb → 95.25 kg (stored canonical, never the caller's lb verbatim).
    expect(data.value).toBeCloseTo(210 * 0.45359237, 5);
    if (result.status === "written") {
      expect(result.measurement.unit).toBe("kg");
    }
  });

  it("refuses an unsupported unit hint without writing", async () => {
    const result = await logMcpMeasurement({
      userId: "u-1",
      type: "WEIGHT",
      value: 12,
      unit: "stone",
      idempotencyKey: "key-stone",
    });

    expect(result.status).toBe("unsupported_unit");
    expect(measurement.create).not.toHaveBeenCalled();
  });

  it("stamps canonical kg when the unit hint is omitted", async () => {
    const result = await logMcpMeasurement({
      userId: "u-1",
      type: "WEIGHT",
      value: 80,
      idempotencyKey: "key-none",
    });

    expect(result.status).toBe("written");
    const data = measurement.create.mock.calls[0][0].data;
    expect(data.unit).toBe("kg");
    expect(data.value).toBe(80);
  });

  it("refuses a non-capturable / clinical-only type without writing", async () => {
    const result = await logMcpMeasurement({
      userId: "u-1",
      type: "RECOVERY_SCORE" as never,
      value: 50,
      idempotencyKey: "key-x",
    });
    expect(result.status).toBe("unsupported_type");
    expect(measurement.create).not.toHaveBeenCalled();
  });

  it("refuses an out-of-range value without writing", async () => {
    const result = await logMcpMeasurement({
      userId: "u-1",
      type: "WEIGHT",
      value: 99999,
      idempotencyKey: "key-y",
    });
    expect(result.status).toBe("out_of_range");
    expect(measurement.create).not.toHaveBeenCalled();
  });

  it("is idempotent — a second call with the same key writes nothing", async () => {
    measurement.findUnique.mockResolvedValue({
      id: "m-1",
      value: 80,
      unit: "kg",
      measuredAt: new Date("2026-06-27T08:00:00Z"),
    });
    const result = await logMcpMeasurement({
      userId: "u-1",
      type: "WEIGHT",
      value: 80,
      idempotencyKey: "key-1",
    });
    expect(result.status).toBe("already_logged");
    expect(measurement.create).not.toHaveBeenCalled();
  });

  it("refuses a far-future (year 9999) measuredAt without writing", async () => {
    const result = await logMcpMeasurement({
      userId: "u-1",
      type: "WEIGHT",
      value: 80,
      measuredAt: new Date("9999-01-01T00:00:00Z"),
      idempotencyKey: "key-future",
    });
    expect(result.status).toBe("out_of_range");
    expect(measurement.create).not.toHaveBeenCalled();
  });

  it("refuses an ancient (year 1000) measuredAt without writing", async () => {
    const result = await logMcpMeasurement({
      userId: "u-1",
      type: "WEIGHT",
      value: 80,
      measuredAt: new Date("1000-01-01T00:00:00Z"),
      idempotencyKey: "key-ancient",
    });
    expect(result.status).toBe("out_of_range");
    expect(measurement.create).not.toHaveBeenCalled();
  });

  it("accepts a now-ish measuredAt", async () => {
    const result = await logMcpMeasurement({
      userId: "u-1",
      type: "WEIGHT",
      value: 80,
      measuredAt: new Date(),
      idempotencyKey: "key-now",
    });
    expect(result.status).toBe("written");
    expect(measurement.create).toHaveBeenCalledTimes(1);
  });

  it("derives the same externalId for the same idempotencyKey", async () => {
    await logMcpMeasurement({
      userId: "u-1",
      type: "PULSE",
      value: 60,
      idempotencyKey: "stable",
    });
    const first = measurement.create.mock.calls[0][0].data.externalId;
    vi.clearAllMocks();
    measurement.findUnique.mockResolvedValue(null);
    measurement.create.mockResolvedValue({ id: "m-2" });
    await logMcpMeasurement({
      userId: "u-1",
      type: "PULSE",
      value: 61,
      idempotencyKey: "stable",
    });
    const second = measurement.create.mock.calls[0][0].data.externalId;
    expect(first).toBe(second);
  });
});

describe("logMcpMood", () => {
  it("writes one mood row with source MCP", async () => {
    const result = await logMcpMood({
      userId: "u-1",
      score: 4,
      idempotencyKey: "mood-1",
    });
    expect(result.status).toBe("written");
    expect(moodEntry.create).toHaveBeenCalledTimes(1);
    const data = moodEntry.create.mock.calls[0][0].data;
    expect(data.source).toBe("MCP");
    expect(data.userId).toBe("u-1");
    expect(data.externalId).toMatch(/^mcp:mood:[0-9a-f]{64}$/);
    expect(auditLog).toHaveBeenCalledWith(
      "mcp.write.mood",
      expect.objectContaining({ userId: "u-1" }),
    );
  });

  it("rejects an out-of-band score without writing", async () => {
    const result = await logMcpMood({
      userId: "u-1",
      score: 9,
      idempotencyKey: "mood-bad",
    });
    expect(result.status).toBe("invalid_score");
    expect(moodEntry.create).not.toHaveBeenCalled();
  });

  it("is idempotent on the same key", async () => {
    moodEntry.findUnique.mockResolvedValue({
      mood: "GUT",
      score: 4,
      note: null,
      date: "2026-06-27",
    });
    const result = await logMcpMood({
      userId: "u-1",
      score: 4,
      idempotencyKey: "mood-1",
    });
    expect(result.status).toBe("already_logged");
    expect(moodEntry.create).not.toHaveBeenCalled();
  });
});

describe("logMcpBloodPressure", () => {
  it("writes BOTH systolic and diastolic rows atomically with one timestamp", async () => {
    const result = await logMcpBloodPressure({
      userId: "u-1",
      systolic: 120,
      diastolic: 80,
      idempotencyKey: "bp-key",
    });

    expect(result.status).toBe("written");
    // Two create calls (sys + dia), executed inside one transaction.
    expect(measurement.create).toHaveBeenCalledTimes(2);
    expect($transaction).toHaveBeenCalledTimes(1);

    const sys = measurement.create.mock.calls[0][0].data;
    const dia = measurement.create.mock.calls[1][0].data;
    expect(sys.type).toBe("BLOOD_PRESSURE_SYS");
    expect(sys.value).toBe(120);
    expect(dia.type).toBe("BLOOD_PRESSURE_DIA");
    expect(dia.value).toBe(80);
    expect(sys.source).toBe("MCP");
    expect(dia.source).toBe("MCP");
    expect(sys.unit).toBe("mmHg");
    // Same shared externalId namespace + the SAME measuredAt instant.
    expect(sys.externalId).toMatch(/^mcp:bp:[0-9a-f]{64}$/);
    expect(sys.externalId).toBe(dia.externalId);
    expect(sys.measuredAt.getTime()).toBe(dia.measuredAt.getTime());
    expect(auditLog).toHaveBeenCalledWith(
      "mcp.write.blood_pressure",
      expect.objectContaining({ userId: "u-1" }),
    );
  });

  it("rejects an implausible pair (systolic ≤ diastolic) without writing", async () => {
    const result = await logMcpBloodPressure({
      userId: "u-1",
      systolic: 80,
      diastolic: 120,
      idempotencyKey: "bp-bad",
    });
    expect(result.status).toBe("out_of_range");
    expect(measurement.create).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range value without writing", async () => {
    const result = await logMcpBloodPressure({
      userId: "u-1",
      systolic: 9999,
      diastolic: 80,
      idempotencyKey: "bp-oor",
    });
    expect(result.status).toBe("out_of_range");
    expect(measurement.create).not.toHaveBeenCalled();
  });

  it("refuses a far-future (year 9999) measuredAt without writing", async () => {
    const result = await logMcpBloodPressure({
      userId: "u-1",
      systolic: 120,
      diastolic: 80,
      measuredAt: new Date("9999-01-01T00:00:00Z"),
      idempotencyKey: "bp-future",
    });
    expect(result.status).toBe("out_of_range");
    expect(measurement.create).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("refuses an ancient (year 1000) measuredAt without writing", async () => {
    const result = await logMcpBloodPressure({
      userId: "u-1",
      systolic: 120,
      diastolic: 80,
      measuredAt: new Date("1000-01-01T00:00:00Z"),
      idempotencyKey: "bp-ancient",
    });
    expect(result.status).toBe("out_of_range");
    expect(measurement.create).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("accepts a now-ish measuredAt", async () => {
    const result = await logMcpBloodPressure({
      userId: "u-1",
      systolic: 120,
      diastolic: 80,
      measuredAt: new Date(),
      idempotencyKey: "bp-now",
    });
    expect(result.status).toBe("written");
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a replay with the same key writes nothing", async () => {
    measurement.findUnique
      .mockResolvedValueOnce({
        value: 120,
        measuredAt: new Date("2026-06-27T08:00:00Z"),
      })
      .mockResolvedValueOnce({ value: 80 });
    const result = await logMcpBloodPressure({
      userId: "u-1",
      systolic: 120,
      diastolic: 80,
      idempotencyKey: "bp-key",
    });
    expect(result.status).toBe("already_logged");
    expect($transaction).not.toHaveBeenCalled();
    if (result.status === "already_logged") {
      expect(result.bloodPressure.systolic).toBe(120);
      expect(result.bloodPressure.diastolic).toBe(80);
    }
  });
});
