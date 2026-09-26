import { describe, it, expect, vi, beforeEach } from "vitest";

const { measurement } = vi.hoisted(() => ({
  measurement: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: { measurement },
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMeasurements: vi.fn(),
}));

vi.mock("@/lib/rollups/after-measurement-mutation", () => ({
  afterMeasurementMutation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addMeta: vi.fn() }),
}));

import {
  logTelegramMeasurement,
  isTelegramCapturableType,
  parseTelegramNumber,
} from "@/lib/measurements/create-from-telegram";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";

beforeEach(() => {
  vi.clearAllMocks();
  measurement.findUnique.mockResolvedValue(null);
  measurement.create.mockResolvedValue({ id: "m-1" });
});

describe("parseTelegramNumber", () => {
  it("parses an integer", () => {
    expect(parseTelegramNumber("72")).toBe(72);
  });
  it("parses a comma decimal (de-DE keyboard)", () => {
    expect(parseTelegramNumber("82,5")).toBe(82.5);
  });
  it("trims surrounding whitespace", () => {
    expect(parseTelegramNumber("  98  ")).toBe(98);
  });
  it("rejects trailing unit noise", () => {
    expect(parseTelegramNumber("72 bpm")).toBeNull();
  });
  it("rejects non-numeric text", () => {
    expect(parseTelegramNumber("done")).toBeNull();
  });
});

describe("isTelegramCapturableType", () => {
  it("accepts single-value metrics", () => {
    expect(isTelegramCapturableType("WEIGHT")).toBe(true);
    expect(isTelegramCapturableType("BLOOD_GLUCOSE")).toBe(true);
  });
  it("rejects blood pressure (needs two values)", () => {
    expect(isTelegramCapturableType("BLOOD_PRESSURE_SYS")).toBe(false);
  });
  it("rejects null / free-text reminders", () => {
    expect(isTelegramCapturableType(null)).toBe(false);
    expect(isTelegramCapturableType(undefined)).toBe(false);
  });
});

describe("logTelegramMeasurement", () => {
  it("writes a Measurement with source=TELEGRAM and the canonical unit", async () => {
    const result = await logTelegramMeasurement({
      userId: "user-1",
      type: "WEIGHT",
      rawText: "82,5",
      tz: "Europe/Berlin",
      externalId: "telegram:measure:7777:555",
    });

    expect(result.status).toBe("ok");
    expect(measurement.create).toHaveBeenCalledTimes(1);
    const data = measurement.create.mock.calls[0][0].data;
    expect(data.userId).toBe("user-1");
    expect(data.type).toBe("WEIGHT");
    expect(data.value).toBe(82.5);
    expect(data.source).toBe("TELEGRAM");
    expect(data.unit).toBe("kg");
    expect(data.externalId).toBe("telegram:measure:7777:555");
    expect(invalidateUserMeasurements).toHaveBeenCalledWith("user-1", {
      evict: true,
    });
    // Rollups refold and the status assessments re-warm through the one
    // shared tail.
    expect(afterMeasurementMutation).toHaveBeenCalledWith(
      "user-1",
      [expect.objectContaining({ type: "WEIGHT" })],
      "telegram-measurement",
    );
  });

  it("rejects a non-numeric reply without writing", async () => {
    const result = await logTelegramMeasurement({
      userId: "user-1",
      type: "WEIGHT",
      rawText: "heavy",
      tz: null,
      externalId: "telegram:measure:7777:556",
    });
    expect(result.status).toBe("invalid_number");
    expect(measurement.create).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range value without writing", async () => {
    const result = await logTelegramMeasurement({
      userId: "user-1",
      type: "WEIGHT",
      rawText: "999",
      tz: null,
      externalId: "telegram:measure:7777:557",
    });
    expect(result.status).toBe("out_of_range");
    expect(measurement.create).not.toHaveBeenCalled();
  });

  it("refuses an unsupported (BP) type", async () => {
    const result = await logTelegramMeasurement({
      userId: "user-1",
      type: "BLOOD_PRESSURE_SYS",
      rawText: "120",
      tz: null,
      externalId: "telegram:measure:7777:558",
    });
    expect(result.status).toBe("unsupported_type");
    expect(measurement.create).not.toHaveBeenCalled();
  });

  it("is idempotent on a redelivered reply (externalId hit)", async () => {
    measurement.findUnique.mockResolvedValue({ id: "existing" });
    const result = await logTelegramMeasurement({
      userId: "user-1",
      type: "PULSE",
      rawText: "60",
      tz: null,
      externalId: "telegram:measure:7777:559",
    });
    expect(result.status).toBe("ok");
    expect(measurement.create).not.toHaveBeenCalled();
  });
});
