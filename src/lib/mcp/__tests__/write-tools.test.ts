import { describe, it, expect, vi, beforeEach } from "vitest";

const logMcpMeasurement = vi.fn();
const logMcpMood = vi.fn();
const logMcpBloodPressure = vi.fn();
const checkMcpMeasurement = vi.fn();
const checkMcpBloodPressure = vi.fn();
const resolveMcpMeasurementUnit = vi.fn();
vi.mock("../writes", () => ({
  logMcpMeasurement: (...a: unknown[]) => logMcpMeasurement(...a),
  logMcpMood: (...a: unknown[]) => logMcpMood(...a),
  logMcpBloodPressure: (...a: unknown[]) => logMcpBloodPressure(...a),
  checkMcpMeasurement: (...a: unknown[]) => checkMcpMeasurement(...a),
  checkMcpBloodPressure: (...a: unknown[]) => checkMcpBloodPressure(...a),
  resolveMcpMeasurementUnit: (...a: unknown[]) =>
    resolveMcpMeasurementUnit(...a),
}));

const checkMcpWriteRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  checkMcpWriteRateLimit: (...a: unknown[]) => checkMcpWriteRateLimit(...a),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { MCP_WRITE_TOOLS, MCP_WRITE_TOOL_NAMES } from "../write-tools";
import type { McpAuthContext } from "../auth";

const CTX: McpAuthContext = {
  userId: "u-1",
  tokenId: "t-1",
  scopes: ["health:read", "health:write"],
  binding: "u-1:t-1",
  canRead: true,
  canWrite: true,
};

function tool(name: string) {
  const t = MCP_WRITE_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

beforeEach(() => {
  vi.clearAllMocks();
  checkMcpWriteRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 1000,
  });
  // Default: the pre-write validation passes, so a preview echoes a clean
  // would-be record. Individual tests override to assert wouldFail.
  checkMcpMeasurement.mockReturnValue({ ok: true });
  checkMcpBloodPressure.mockReturnValue({ ok: true });
  // Default: the unit hint resolves to canonical, echoing the value through.
  resolveMcpMeasurementUnit.mockImplementation(
    (_type: string, value: number) => ({ ok: true, value, unit: "kg" }),
  );
});

describe("write-tool surface", () => {
  it("exposes exactly log_measurement, log_mood, and log_blood_pressure", () => {
    expect([...MCP_WRITE_TOOL_NAMES].sort()).toEqual([
      "log_blood_pressure",
      "log_measurement",
      "log_mood",
    ]);
  });

  it("every write tool declares a structured outputSchema", () => {
    for (const t of MCP_WRITE_TOOLS) {
      expect(t.outputShape, `${t.name} lacks outputShape`).toBeDefined();
    }
  });

  it("annotates writes as non-read-only, non-destructive, idempotent", () => {
    for (const t of MCP_WRITE_TOOLS) {
      expect(t.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });
});

describe("confirm gate — log_measurement", () => {
  it("confirm:false returns a preview and writes NOTHING", async () => {
    const result = (await tool("log_measurement").run(CTX, {
      type: "WEIGHT",
      value: 80,
      idempotencyKey: "k-1",
    })) as Record<string, unknown>;

    expect(result.requiresConfirmation).toBe(true);
    expect(result.written).toBe(false);
    expect(result.preview).toMatchObject({
      type: "WEIGHT",
      value: 80,
      source: "MCP",
    });
    expect(logMcpMeasurement).not.toHaveBeenCalled();
    expect(checkMcpWriteRateLimit).not.toHaveBeenCalled();
  });

  it("confirm:true executes the core and reports the written record", async () => {
    logMcpMeasurement.mockResolvedValue({
      status: "written",
      measurement: {
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: "x",
        source: "MCP",
      },
    });
    const result = (await tool("log_measurement").run(CTX, {
      type: "WEIGHT",
      value: 80,
      confirm: true,
      idempotencyKey: "k-1",
    })) as Record<string, unknown>;

    expect(logMcpMeasurement).toHaveBeenCalledTimes(1);
    expect(logMcpMeasurement).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-1",
        type: "WEIGHT",
        value: 80,
        idempotencyKey: "k-1",
      }),
    );
    expect(result.written).toBe(true);
  });

  it("an idempotent replay reports alreadyLogged, not a duplicate write", async () => {
    logMcpMeasurement.mockResolvedValue({
      status: "already_logged",
      measurement: {
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: "x",
        source: "MCP",
      },
    });
    const result = (await tool("log_measurement").run(CTX, {
      type: "WEIGHT",
      value: 80,
      confirm: true,
      idempotencyKey: "k-1",
    })) as Record<string, unknown>;
    expect(result.written).toBe(false);
    expect(result.alreadyLogged).toBe(true);
  });

  it("refuses to commit when the write budget is exhausted", async () => {
    checkMcpWriteRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 1000,
    });
    const result = (await tool("log_measurement").run(CTX, {
      type: "WEIGHT",
      value: 80,
      confirm: true,
      idempotencyKey: "k-1",
    })) as Record<string, unknown>;
    expect(result.written).toBe(false);
    expect(result.error).toBe("rate_limited");
    expect(logMcpMeasurement).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric value before any write", async () => {
    const result = (await tool("log_measurement").run(CTX, {
      type: "WEIGHT",
      value: Number.NaN,
      confirm: true,
      idempotencyKey: "k-1",
    })) as Record<string, unknown>;
    expect(result.written).toBe(false);
    expect(logMcpMeasurement).not.toHaveBeenCalled();
  });

  it("a preview that would be refused on commit carries wouldFail + reason", async () => {
    checkMcpMeasurement.mockReturnValue({
      ok: false,
      error: "out_of_range",
      reason: "Timestamp must not be in the future",
    });
    const result = (await tool("log_measurement").run(CTX, {
      type: "WEIGHT",
      value: 80,
      measuredAt: "9999-01-01T00:00:00Z",
      idempotencyKey: "k-1",
    })) as Record<string, unknown>;
    // Still a preview — nothing written — but the commit verdict is surfaced.
    expect(result.requiresConfirmation).toBe(true);
    expect(result.written).toBe(false);
    expect(result.wouldFail).toBe(true);
    expect(result.error).toBe("out_of_range");
    expect(result.reason).toBe("Timestamp must not be in the future");
    expect(logMcpMeasurement).not.toHaveBeenCalled();
  });
});

describe("confirm gate — log_mood", () => {
  it("confirm:false returns a preview and writes NOTHING", async () => {
    const result = (await tool("log_mood").run(CTX, {
      score: 4,
      idempotencyKey: "m-1",
    })) as Record<string, unknown>;
    expect(result.requiresConfirmation).toBe(true);
    expect(result.written).toBe(false);
    expect(logMcpMood).not.toHaveBeenCalled();
  });

  it("confirm:true commits the mood entry", async () => {
    logMcpMood.mockResolvedValue({
      status: "written",
      moodEntry: {
        score: 4,
        mood: "GUT",
        note: null,
        date: "2026-06-27",
        source: "MCP",
      },
    });
    const result = (await tool("log_mood").run(CTX, {
      score: 4,
      confirm: true,
      idempotencyKey: "m-1",
    })) as Record<string, unknown>;
    expect(logMcpMood).toHaveBeenCalledTimes(1);
    expect(result.written).toBe(true);
  });

  it("rejects an out-of-band score before any write", async () => {
    const result = (await tool("log_mood").run(CTX, {
      score: 9,
      confirm: true,
      idempotencyKey: "m-1",
    })) as Record<string, unknown>;
    expect(result.written).toBe(false);
    expect(logMcpMood).not.toHaveBeenCalled();
  });
});

describe("confirm gate — log_blood_pressure", () => {
  it("confirm:false previews BOTH values and writes nothing", async () => {
    const result = (await tool("log_blood_pressure").run(CTX, {
      systolic: 120,
      diastolic: 80,
      idempotencyKey: "bp-1",
    })) as Record<string, unknown>;
    expect(result.requiresConfirmation).toBe(true);
    expect(result.written).toBe(false);
    expect(result.preview).toMatchObject({
      systolic: 120,
      diastolic: 80,
      unit: "mmHg",
      source: "MCP",
    });
    expect(logMcpBloodPressure).not.toHaveBeenCalled();
    expect(checkMcpWriteRateLimit).not.toHaveBeenCalled();
  });

  it("confirm:true commits the paired reading", async () => {
    logMcpBloodPressure.mockResolvedValue({
      status: "written",
      bloodPressure: {
        systolic: 120,
        diastolic: 80,
        unit: "mmHg",
        measuredAt: "x",
        source: "MCP",
      },
    });
    const result = (await tool("log_blood_pressure").run(CTX, {
      systolic: 120,
      diastolic: 80,
      confirm: true,
      idempotencyKey: "bp-1",
    })) as Record<string, unknown>;
    expect(logMcpBloodPressure).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-1",
        systolic: 120,
        diastolic: 80,
        idempotencyKey: "bp-1",
      }),
    );
    expect(result.written).toBe(true);
  });

  it("an idempotent replay reports alreadyLogged", async () => {
    logMcpBloodPressure.mockResolvedValue({
      status: "already_logged",
      bloodPressure: {
        systolic: 120,
        diastolic: 80,
        unit: "mmHg",
        measuredAt: "x",
        source: "MCP",
      },
    });
    const result = (await tool("log_blood_pressure").run(CTX, {
      systolic: 120,
      diastolic: 80,
      confirm: true,
      idempotencyKey: "bp-1",
    })) as Record<string, unknown>;
    expect(result.written).toBe(false);
    expect(result.alreadyLogged).toBe(true);
  });

  it("surfaces an out-of-range refusal from the core", async () => {
    logMcpBloodPressure.mockResolvedValue({
      status: "out_of_range",
      reason: "Systolic must be greater than diastolic",
    });
    const result = (await tool("log_blood_pressure").run(CTX, {
      systolic: 80,
      diastolic: 120,
      confirm: true,
      idempotencyKey: "bp-2",
    })) as Record<string, unknown>;
    expect(result.written).toBe(false);
    expect(result.error).toBe("out_of_range");
  });

  it("rejects a non-numeric value before any write", async () => {
    const result = (await tool("log_blood_pressure").run(CTX, {
      systolic: Number.NaN,
      diastolic: 80,
      confirm: true,
      idempotencyKey: "bp-3",
    })) as Record<string, unknown>;
    expect(result.written).toBe(false);
    expect(logMcpBloodPressure).not.toHaveBeenCalled();
  });
});
