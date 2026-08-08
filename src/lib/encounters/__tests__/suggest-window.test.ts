/**
 * The suggestion rule, pinned.
 *
 * Two properties carry the whole feature and both are easy to break without
 * noticing:
 *
 *   - the window is ±7 days and not "recently";
 *   - two candidates offer a picker with nothing pre-selected, and never the
 *     first one.
 *
 * Every fixture is RELATIVE to the moment the test runs (`now − 3 days`, never
 * `2026-03-14`). A fixed-date fixture slides out of a relative window as the
 * calendar moves and the test rots into a false green; this repository has
 * shipped that bug before.
 *
 * The fake below honours the `where` it is given. A fake that ignores it would
 * return every seeded row for every query, so the window assertions would pass
 * against a module with no window at all — a check that cannot fail is worse
 * than none.
 *
 * Mutation checks (both run, both seen red):
 *   - widen `ENCOUNTER_SUGGEST_WINDOW_DAYS` to 90 → the out-of-window cases go
 *     red naming the 30-day visit that started matching;
 *   - make the two-candidate branch return `{ kind: "one" }` with the first row
 *     → "offers a picker with nothing pre-selected" goes red.
 */
import { describe, it, expect } from "vitest";

import {
  ENCOUNTER_SUGGEST_WINDOW_DAYS,
  suggestEncounterForDate,
} from "../suggest-window";
import type { Prisma } from "@/generated/prisma/client";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

interface Row {
  id: string;
  userId: string;
  occurredAt: Date;
  status: string;
  kind: string;
  deletedAt: Date | null;
  practitioner: { name: string } | null;
}

function row(over: Partial<Row> & { id: string; occurredAt: Date }): Row {
  return {
    userId: "u1",
    status: "DONE",
    kind: "ROUTINE",
    deletedAt: null,
    practitioner: null,
    ...over,
  };
}

/**
 * An in-memory `encounter.findMany` that actually applies the filter.
 *
 * It evaluates every clause the module writes — the record id, the tombstone,
 * the status set and both window edges — so a module that dropped one of them
 * returns rows this fake would have excluded, and the assertion below fails.
 */
function fakeTx(rows: Row[]): Prisma.TransactionClient {
  return {
    encounter: {
      findMany: async (args: {
        where: {
          userId: string;
          deletedAt: null;
          status: { in: string[] };
          occurredAt: { gte: Date; lte: Date };
        };
        take?: number;
      }) => {
        const { where } = args;
        const matched = rows
          .filter((r) => r.userId === where.userId)
          .filter((r) =>
            where.deletedAt === null ? r.deletedAt === null : true,
          )
          .filter((r) => where.status.in.includes(r.status))
          .filter(
            (r) =>
              r.occurredAt.getTime() >= where.occurredAt.gte.getTime() &&
              r.occurredAt.getTime() <= where.occurredAt.lte.getTime(),
          )
          .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
        return matched.slice(0, args.take ?? matched.length);
      },
    },
  } as unknown as Prisma.TransactionClient;
}

const anchor = new Date();
const ago = (days: number, extraMs = 0) =>
  new Date(anchor.getTime() - days * DAY_MS - extraMs);
const ahead = (days: number, extraMs = 0) =>
  new Date(anchor.getTime() + days * DAY_MS + extraMs);

describe("the window", () => {
  it("is seven days wide on each side", () => {
    expect(ENCOUNTER_SUGGEST_WINDOW_DAYS).toBe(7);
  });

  it("admits a visit exactly seven days before the anchor", async () => {
    const result = await suggestEncounterForDate(
      fakeTx([row({ id: "e1", occurredAt: ago(7) })]),
      { userId: "u1", anchor },
    );
    expect(result).toEqual({
      kind: "one",
      encounter: expect.objectContaining({ id: "e1" }),
    });
  });

  it("admits a visit exactly seven days after the anchor", async () => {
    const result = await suggestEncounterForDate(
      fakeTx([row({ id: "e1", occurredAt: ahead(7) })]),
      { userId: "u1", anchor },
    );
    expect(result).toEqual({
      kind: "one",
      encounter: expect.objectContaining({ id: "e1" }),
    });
  });

  it("refuses a visit seven days and one minute before the anchor", async () => {
    const result = await suggestEncounterForDate(
      fakeTx([row({ id: "e1", occurredAt: ago(7, MINUTE_MS) })]),
      { userId: "u1", anchor },
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("refuses a visit seven days and one minute after the anchor", async () => {
    const result = await suggestEncounterForDate(
      fakeTx([row({ id: "e1", occurredAt: ahead(7, MINUTE_MS) })]),
      { userId: "u1", anchor },
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("refuses a visit thirty days out", async () => {
    // The widened-window mutation lands here first: at ±90 days this row
    // starts matching and the verdict stops being "none".
    const result = await suggestEncounterForDate(
      fakeTx([row({ id: "far", occurredAt: ahead(30) })]),
      { userId: "u1", anchor },
    );
    expect(result).toEqual({ kind: "none" });
  });
});

describe("the verdict", () => {
  it("offers nothing when there is no candidate", async () => {
    const result = await suggestEncounterForDate(fakeTx([]), {
      userId: "u1",
      anchor,
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("pre-selects the single candidate, resolved", async () => {
    const result = await suggestEncounterForDate(
      fakeTx([
        row({
          id: "e1",
          occurredAt: ago(3),
          kind: "SPECIALIST",
          practitioner: { name: "Praxis am Park" },
        }),
      ]),
      { userId: "u1", anchor },
    );
    expect(result).toEqual({
      kind: "one",
      encounter: {
        id: "e1",
        occurredAt: ago(3).toISOString(),
        status: "DONE",
        kind: "SPECIALIST",
        practitionerName: "Praxis am Park",
      },
    });
  });

  it("offers a picker with nothing pre-selected for two candidates", async () => {
    const result = await suggestEncounterForDate(
      fakeTx([
        row({ id: "e1", occurredAt: ago(3) }),
        row({ id: "e2", occurredAt: ago(1) }),
      ]),
      { userId: "u1", anchor },
    );
    // The shape is the assertion: there is no field on a "many" verdict a
    // caller could read as a pre-selection.
    expect(result.kind).toBe("many");
    expect(result).not.toHaveProperty("encounter");
    if (result.kind !== "many") throw new Error("unreachable");
    expect(result.encounters.map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});

describe("what is never a candidate", () => {
  it("a soft-deleted visit", async () => {
    const result = await suggestEncounterForDate(
      fakeTx([row({ id: "e1", occurredAt: ago(1), deletedAt: new Date() })]),
      { userId: "u1", anchor },
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("a cancelled visit, and a no-show", async () => {
    // Neither happened, so neither produced the record being filed. Admitting
    // them would widen the set with rows that are wrong most of the time.
    const result = await suggestEncounterForDate(
      fakeTx([
        row({ id: "e1", occurredAt: ago(1), status: "CANCELLED" }),
        row({ id: "e2", occurredAt: ago(2), status: "NO_SHOW" }),
      ]),
      { userId: "u1", anchor },
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("another account's visit", async () => {
    const result = await suggestEncounterForDate(
      fakeTx([row({ id: "e1", occurredAt: ago(1), userId: "u2" })]),
      { userId: "u1", anchor },
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("an unusable anchor", async () => {
    const result = await suggestEncounterForDate(
      fakeTx([row({ id: "e1", occurredAt: ago(1) })]),
      { userId: "u1", anchor: new Date("not a date") },
    );
    expect(result).toEqual({ kind: "none" });
  });
});
