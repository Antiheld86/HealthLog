/**
 * v1.30.22 — the fail-closed backstop inside `collectDoctorReportData`.
 *
 * The MCP surfaces now gate before calling, but gating only at call sites is
 * exactly the arrangement that failed: `loadFhirContext` has an internal
 * backstop for the same aggregate and the routes above it still gate, while
 * this function had none and three MCP callers plus a public share link
 * forgot. The backstop makes the door itself refuse, so the next caller
 * cannot reintroduce the leak by omission.
 *
 * It throws rather than returning an envelope because reaching it means a
 * caller is missing its gate — a bug to surface, not a flow to serve. Callers
 * that can degrade gracefully (the MCP resources, the clinician share) gate
 * themselves first and never reach it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  // Every model access throws, so any DB touch past the backstop is loud.
  const boom = () => {
    throw new Error("DB touched");
  };
  return {
    prismaMock: new Proxy(
      {},
      {
        get: () => new Proxy({}, { get: () => boom }),
      },
    ),
  };
});
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/modules/gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/modules/gate")>();
  return { ...actual, resolveModuleMap: vi.fn() };
});

import { collectDoctorReportData } from "../doctor-report-data";
import { resolveModuleMap, MODULE_KEYS } from "@/lib/modules/gate";
import {
  EMPTY_REPORT_SELECTION,
  selectionFromLeaves,
} from "@/lib/report-selection/selection";

const RANGE = {
  start: new Date("2026-01-01T00:00:00.000Z"),
  end: new Date("2026-04-01T00:00:00.000Z"),
  days: 90,
};

/** Every module on, then apply the overrides. */
function moduleMap(overrides: Record<string, boolean> = {}) {
  const out: Record<string, boolean> = {};
  for (const key of MODULE_KEYS) out[key] = true;
  return { ...out, ...overrides } as Record<string, boolean>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("collectDoctorReportData — doctorReport backstop", () => {
  it("throws before any DB read when the module is off", async () => {
    await expect(
      collectDoctorReportData(
        "u1",
        RANGE,
        EMPTY_REPORT_SELECTION,
        // Injected rather than read, so the refusal is attributable to the
        // module state and not to a DB stub.
        {
          moduleMap: moduleMap({
            doctorReport: false,
          }) as never,
        },
      ),
    ).rejects.toThrow(/doctorReport/);
  });

  it("resolves the map itself when none is injected, and still refuses", async () => {
    // The real callers do not inject; this is the path that actually protects
    // the aggregate in production.
    vi.mocked(resolveModuleMap).mockResolvedValue(
      moduleMap({ doctorReport: false }) as never,
    );

    await expect(
      collectDoctorReportData("u1", RANGE, EMPTY_REPORT_SELECTION),
    ).rejects.toThrow(/doctorReport/);
    expect(resolveModuleMap).toHaveBeenCalledWith("u1");
  });

  it("does not refuse when the module is on", async () => {
    // Positive control. The aggregate needs a full DB behind it, which this
    // suite deliberately does not provide — so it will fail on the first
    // query. What matters is that it gets THERE: the failure must be the DB
    // stub, never the backstop, or the "off" assertions above would pass
    // trivially for a function that always throws.
    await expect(
      collectDoctorReportData("u1", RANGE, selectionFromLeaves(["WEIGHT"]), {
        moduleMap: moduleMap() as never,
      }),
    ).rejects.toThrow("DB touched");
  });
});
