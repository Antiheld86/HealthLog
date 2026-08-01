/**
 * The cycle-verdict guard, checked against itself.
 *
 * A structural check that cannot fail reads as proof and is not. So each case
 * below is a disguise someone would plausibly reach for while putting the
 * client-side cycle derivation back — renaming the constant, inlining the
 * number, lifting it into a variable one line above the comparison (the move
 * that defeated a guard in this repo before), hiding it in an object, in a
 * default parameter, behind a helper — and each is asserted to be caught by
 * the SAME detector the real guard runs.
 *
 * The second half matters just as much: a detector that flags everything is
 * a detector nobody keeps. So the innocent shapes are pinned too, including
 * the one the client is SUPPOSED to write.
 *
 * These sources are strings on purpose. They are the shapes that must not
 * ship, so none of them may live in a file the app can import.
 */
import { describe, expect, it } from "vitest";

import {
  derivationFindings,
  parse,
  type FindingKind,
} from "./helpers/cycle-verdict-derivation";

const FILE = "disguise.tsx";

/** Every cycle-context source needs the vocabulary a real derivation would use. */
const PREAMBLE = `import type { CalendarDay, CyclePhase } from "./types";\n`;

function kinds(source: string): FindingKind[] {
  return derivationFindings(parse(FILE, PREAMBLE + source)).map((f) => f.kind);
}

describe("the guard catches the derivation it was written for", () => {
  it("catches the exact constant that was copied", () => {
    expect(
      kinds(`const OVERDUE_GRACE_DAYS = 14;
             export function wheel(days: CalendarDay[]) { return days; }`),
    ).toContain("grace-constant");
  });

  it("catches it renamed — it reads the shape, not the old name", () => {
    expect(kinds(`const graceWindow = 14;`)).toContain("grace-constant");
    expect(kinds(`const overdueAfterDays = 21;`)).toContain("grace-constant");
  });

  it("catches it hidden in an object literal", () => {
    expect(
      kinds(`const tuning = { overdueGraceDays: 14, cycleLength: 28 };`),
    ).toContain("grace-constant");
  });

  it("catches it hidden in a default parameter", () => {
    expect(
      kinds(
        `export function wheel(days: CalendarDay[], graceDays = 14) { return days.length > graceDays; }`,
      ),
    ).toContain("grace-constant");
  });

  it("catches the verdict being computed rather than read", () => {
    expect(
      kinds(
        `const dayOfCycle = 43;
         const typical = 28;
         const periodOverdue = dayOfCycle > typical + 14;`,
      ),
    ).toContain("client-derived-verdict");
  });

  it("catches the threshold LIFTED INTO A VARIABLE one line up", () => {
    // The move that defeated a guard here before: no literal and no sum sit
    // next to the comparison any more, and nothing is named suspiciously.
    // The detector follows the local binding instead of reading the line.
    expect(
      kinds(
        `const limit = 28;
         const slack = 14;
         const ceiling = limit + slack;
         const dayOfCycle = 43;
         const stale = dayOfCycle > ceiling;`,
      ),
    ).toContain("day-count-threshold");
  });

  it("catches it lifted twice", () => {
    expect(
      kinds(
        `const limit = 28;
         const slack = 14;
         const ceiling = limit + slack;
         const bound = ceiling;
         const dayOfCycle = 43;
         const stale = dayOfCycle > bound;`,
      ),
    ).toContain("day-count-threshold");
  });

  it("catches the sum written inline", () => {
    expect(
      kinds(
        `const limit = 28;
         const slack = 14;
         const dayOfCycle = 43;
         const stale = dayOfCycle > limit + slack;`,
      ),
    ).toContain("day-count-threshold");
  });

  it("catches the shape with no suspicious name anywhere", () => {
    // Nothing here is called grace, overdue, or late. The count compared
    // against a sum is the whole tell.
    expect(
      kinds(
        `function ring(dayOfCycle: number, a: number, b: number) {
           return dayOfCycle >= a + b ? null : dayOfCycle;
         }`,
      ),
    ).toContain("day-count-threshold");
  });

  it("catches it with the operands swapped", () => {
    expect(
      kinds(
        `function ring(dayOfCycle: number, a: number, b: number) {
           return a + b < dayOfCycle;
         }`,
      ),
    ).toContain("day-count-threshold");
  });

  it("catches a class field carrying the window", () => {
    expect(kinds(`class Wheel { private overdueGrace = 14; }`)).toContain(
      "grace-constant",
    );
  });
});

describe("the guard stays quiet on innocent code", () => {
  it("says nothing about reading the published state — the correct shape", () => {
    expect(
      kinds(
        `const verdict = calendar.data?.verdict;
         const periodOverdue = verdict?.state === "OVERDUE";
         const dayOfCycle = verdict?.dayOfCycle ?? null;
         const overdueDays = verdict?.overdueDays ?? null;`,
      ),
    ).toEqual([]);
  });

  it("says nothing about drawing the ring from the published numbers", () => {
    expect(
      kinds(
        `function ring(dayOfCycle: number | null, cycleLength: number | null) {
           if (dayOfCycle == null || cycleLength == null || cycleLength <= 0) return 0;
           return Math.min((dayOfCycle - 1) / cycleLength, 1);
         }`,
      ),
    ).toEqual([]);
  });

  it("says nothing about a cycle-day count printed in copy", () => {
    expect(
      kinds(
        `const label = dayOfCycle != null ? t("cycle.ring.dayOfCycle", { day: dayOfCycle }) : null;`,
      ),
    ).toEqual([]);
  });

  it("says nothing about an overdue medication dose", () => {
    // The same English word, a different domain, no cycle vocabulary — the
    // medication card decides its own overdue state and always has.
    expect(
      derivationFindings(
        parse(
          "medication-card.tsx",
          `const overdue = dueAt != null && dueAt + graceMinutes < now;
           const OVERDUE_GRACE_MINUTES = 30;`,
        ),
      ),
    ).toEqual([]);
  });

  it("says nothing about an unrelated grace constant outside the cycle", () => {
    expect(
      derivationFindings(
        parse("tour-launcher.tsx", `const POST_WIZARD_GRACE_MS = 4000;`),
      ),
    ).toEqual([]);
  });
});
