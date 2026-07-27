/**
 * The intraday-shape backup pair, and the two ways one row can be wrong.
 *
 * The end-to-end proof lives in the restore round-trip suite; this file covers
 * what that one cannot: the refusals. Both are cases where writing the row
 * would succeed and the day would then be missing from the feature anyway,
 * which is the failure mode the whole backup guard exists to make loud.
 */
import { describe, expect, it, vi } from "vitest";

// The slot-count module reaches for the global Prisma client at load; this
// test only wants the constant off it.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { PROFILE_HOURS } from "@/lib/measurements/intraday-cumulative-profile";
import {
  buildIntradayProfileBackupSection,
  countIntradayProfileBackupSection,
  restoreIntradayProfileData,
  PROFILE_BACKUP_HOURS,
  type IntradayProfileBackupEntry,
} from "@/lib/export/intraday-profile-backup";

const CURVE = Array.from({ length: 24 }, (_, h) => h * 100);

function sourceRow() {
  return {
    id: "shape-1",
    userId: "user-A",
    type: "ACTIVITY_STEPS",
    dateKey: "2026-07-18",
    hourlyCumulative: CURVE,
    dayTotal: CURVE[23],
    sampleCount: 96,
    timezone: "Europe/Berlin",
    createdAt: new Date("2026-07-19T02:00:00.000Z"),
    updatedAt: new Date("2026-07-19T02:00:00.000Z"),
  };
}

function client() {
  return {
    intradayCumulativeProfile: {
      findMany: vi.fn().mockResolvedValue([sourceRow()]),
    },
  } as never;
}

function entry(
  overrides: Partial<IntradayProfileBackupEntry> = {},
): IntradayProfileBackupEntry {
  return {
    type: "ACTIVITY_STEPS" as IntradayProfileBackupEntry["type"],
    dateKey: "2026-07-18",
    hourlyCumulative: CURVE,
    dayTotal: CURVE[23],
    sampleCount: 96,
    timezone: "Europe/Berlin",
    ...overrides,
  };
}

function tx(created: Array<Record<string, unknown>>) {
  return {
    intradayCumulativeProfile: {
      deleteMany: vi.fn().mockResolvedValue({ count: 3 }),
      createMany: vi.fn(async (args: { data: Record<string, unknown>[] }) => {
        created.push(...args.data);
        return { count: args.data.length };
      }),
    },
  } as never;
}

describe("intraday profile backup", () => {
  it("carries the same slot count the reader indexes by", () => {
    // Re-declared rather than imported, so it is pinned here instead: a change
    // to one without the other would put rows in the table that every read
    // path drops.
    expect(PROFILE_BACKUP_HOURS).toBe(PROFILE_HOURS);
  });

  it("gives a disaster-recovery payload the row's own identity", async () => {
    const section = await buildIntradayProfileBackupSection(
      client(),
      "user-A",
      {
        purpose: "disaster-recovery",
      },
    );

    expect(section.intradayProfiles).toHaveLength(1);
    expect(section.intradayProfiles[0]).toMatchObject({
      id: "shape-1",
      type: "ACTIVITY_STEPS",
      dateKey: "2026-07-18",
      hourlyCumulative: CURVE,
      dayTotal: CURVE[23],
      sampleCount: 96,
      timezone: "Europe/Berlin",
      createdAt: "2026-07-19T02:00:00.000Z",
      updatedAt: "2026-07-19T02:00:00.000Z",
    });
    expect(countIntradayProfileBackupSection(section)).toEqual({
      intradayProfiles: 1,
    });
  });

  it("leaves the row identity out of a portable export", async () => {
    const section = await buildIntradayProfileBackupSection(client(), "user-A");

    expect(section.intradayProfiles[0]).not.toHaveProperty("id");
    expect(section.intradayProfiles[0]).not.toHaveProperty("createdAt");
    // The shape itself still travels — it is the only copy either way.
    expect(section.intradayProfiles[0].hourlyCumulative).toEqual(CURVE);
  });

  it("restores the curve and reports what it cleared", async () => {
    const created: Array<Record<string, unknown>> = [];
    const cleared = await restoreIntradayProfileData(tx(created), "user-B", {
      intradayProfiles: [entry({ id: "shape-1" })],
    });

    expect(cleared).toEqual({ intradayProfiles: 3 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: "shape-1",
      userId: "user-B",
      dateKey: "2026-07-18",
      hourlyCumulative: CURVE,
    });
  });

  it("refuses two curves for the same metric and day, naming the day", async () => {
    const created: Array<Record<string, unknown>> = [];

    await expect(
      restoreIntradayProfileData(tx(created), "user-B", {
        intradayProfiles: [entry(), entry({ dayTotal: 1 })],
      }),
    ).rejects.toThrow(/ACTIVITY_STEPS on 2026-07-18/);
    expect(
      created,
      "nothing may land when the file contradicts itself",
    ).toEqual([]);
  });

  it("refuses a curve that is not a whole day, naming the day", async () => {
    const created: Array<Record<string, unknown>> = [];

    await expect(
      restoreIntradayProfileData(tx(created), "user-B", {
        intradayProfiles: [entry({ hourlyCumulative: CURVE.slice(0, 23) })],
      }),
    ).rejects.toThrow(/23 hourly slots, not 24/);
    expect(created, "a row every reader drops is worse than none").toEqual([]);
  });
});
