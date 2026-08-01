/**
 * The preventive-care block hands the briefing model two bare numbers per
 * checkup — "due in N days", "overdue by N days" — and the model writes them
 * into prose the person reads next to the checkup screens. So the number has
 * to answer the same question the screens answer: how many dates away is it on
 * the person's own calendar, not how many hours away divided by twenty-four.
 *
 * Every case below is one where those two answers differ. Each instant carries
 * an explicit offset so the suite says the same thing whatever zone the machine
 * running it is set to.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { measurementReminder: { findMany: vi.fn() } },
}));

import { prisma } from "@/lib/db";
import { readPreventiveCareBlock } from "../feature-blocks";

const prismaMock = prisma as unknown as {
  measurementReminder: { findMany: ReturnType<typeof vi.fn> };
};

/**
 * The profile zone under test. July is deliberate: no IANA zone shifts its
 * clocks mid-July, so a fixed offset stands for the whole month and building
 * 00:01 or 23:59 can never land on a skipped or repeated hour.
 */
const ZONE = "Europe/Berlin";
const ZONE_OFFSET = "+02:00";

// Fri 17th, Sat 18th, Sun 19th of July 2026.
const FRIDAY = 17;
const SATURDAY = 18;
const SUNDAY = 19;

const pad = (n: number) => String(n).padStart(2, "0");

/** A wall-clock time in {@link ZONE}, as the instant the column stores. */
function zoned(day: number, hour: number, minute = 0): Date {
  return new Date(
    `2026-07-${pad(day)}T${pad(hour)}:${pad(minute)}:00${ZONE_OFFSET}`,
  );
}

/** The same wall clock as the epoch millis the caller passes for `now`. */
function at(day: number, hour: number, minute = 0): number {
  return zoned(day, hour, minute).getTime();
}

/** One reminder due at the given instant, as the only row the read returns. */
function onlyReminder(nextDueAt: Date) {
  prismaMock.measurementReminder.findMany.mockResolvedValue([
    { label: "Augenarzt", nextDueAt },
  ]);
}

beforeEach(() => {
  prismaMock.measurementReminder.findMany.mockReset();
});

describe("readPreventiveCareBlock counts calendar days, not hours", () => {
  it("keeps a checkup booked for this morning on today's list all day", async () => {
    // Eleven hours in the past, and still the checkup for today. An hour count
    // moved it to the overdue list and then rounded the count to nothing, so
    // the payload said "overdue by 0 days" about something not yet missed.
    onlyReminder(zoned(FRIDAY, 9));
    const block = await readPreventiveCareBlock("user-1", at(FRIDAY, 20), ZONE);

    expect(block?.overdue).toEqual([]);
    expect(block?.due).toEqual([{ label: "Augenarzt", daysUntil: 0 }]);
  });

  it("calls a Sunday 01:00 checkup two days out when read late on Friday", async () => {
    // Twenty-six hours apart, so an hour count rounds to one and the briefing
    // says tomorrow. Two dates separate them on the calendar.
    onlyReminder(zoned(SUNDAY, 1));
    const block = await readPreventiveCareBlock("user-1", at(FRIDAY, 23), ZONE);

    expect(block?.due).toEqual([{ label: "Augenarzt", daysUntil: 2 }]);
  });

  it("calls a Saturday 23:59 checkup one day out when read just after Friday midnight", async () => {
    // Just under forty-eight hours apart, so an hour count rounds to two. It is
    // the very next date on the calendar.
    onlyReminder(zoned(SATURDAY, 23, 59));
    const block = await readPreventiveCareBlock(
      "user-1",
      at(FRIDAY, 0, 1),
      ZONE,
    );

    expect(block?.due).toEqual([{ label: "Augenarzt", daysUntil: 1 }]);
  });

  it("counts a checkup missed yesterday as one day overdue, however recent", async () => {
    // Forty-five minutes in the past. It was still yesterday's checkup, and an
    // hour count called it overdue by nothing at all.
    onlyReminder(zoned(FRIDAY, 23, 30));
    const block = await readPreventiveCareBlock(
      "user-1",
      at(SATURDAY, 0, 15),
      ZONE,
    );

    expect(block?.due).toEqual([]);
    expect(block?.overdue).toEqual([{ label: "Augenarzt", daysOverdue: 1 }]);
  });

  it("keeps a whole clock-change day as one day", async () => {
    // The Berlin day the clocks go back is twenty-five hours long, so an hour
    // count rounds a same-day evening checkup up to tomorrow.
    onlyReminder(new Date("2026-10-25T22:00:00Z")); // 23:00 Berlin, after
    const block = await readPreventiveCareBlock(
      "user-1",
      Date.parse("2026-10-25T00:00:00Z"), // 02:00 Berlin, before
      ZONE,
    );

    expect(block?.due).toEqual([{ label: "Augenarzt", daysUntil: 0 }]);
  });
});

describe("readPreventiveCareBlock counts on the profile's calendar", () => {
  // 22:30 UTC on the 17th is already 00:30 on the 18th in Berlin, and the
  // checkup at 21:00 UTC on the 18th is 23:00 Berlin on that same 18th. So
  // Berlin says today and UTC says tomorrow about one identical pair of
  // instants. Asserting BOTH is what makes this bite: an implementation that
  // ignores the zone it is given returns the same number twice.
  const NOW = Date.parse("2026-07-17T22:30:00Z");
  const DUE = new Date("2026-07-18T21:00:00Z");

  it("gives two profiles either side of midnight two different counts", async () => {
    onlyReminder(DUE);
    const berlin = await readPreventiveCareBlock(
      "user-1",
      NOW,
      "Europe/Berlin",
    );
    onlyReminder(DUE);
    const utc = await readPreventiveCareBlock("user-1", NOW, "UTC");

    expect(berlin?.due).toEqual([{ label: "Augenarzt", daysUntil: 0 }]);
    expect(utc?.due).toEqual([{ label: "Augenarzt", daysUntil: 1 }]);
  });

  /**
   * The machine's own clock, moved under the function's feet. `vitest.config`
   * pins the suite to UTC, and a `TZ=` prefix on the command line does not
   * override that — the only way into another host zone is to assign
   * `process.env.TZ`, which is what this does. Whatever the host is set to,
   * the answer must not move: that is the difference between reading the
   * profile and reading the server the code happens to run on.
   */
  const HOST_ZONES = ["UTC", "Pacific/Auckland", "America/Los_Angeles"];

  it("ignores the zone the host machine itself is set to", async () => {
    const original = process.env.TZ;
    const answers: Array<number | undefined> = [];
    try {
      for (const hostZone of HOST_ZONES) {
        process.env.TZ = hostZone;
        onlyReminder(DUE);
        const block = await readPreventiveCareBlock("user-1", NOW, ZONE);
        answers.push(block?.due[0]?.daysUntil);
      }
    } finally {
      process.env.TZ = original;
    }

    expect(answers).toEqual([0, 0, 0]);
  });
});
