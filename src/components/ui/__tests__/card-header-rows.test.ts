/**
 * The Card header reserves its second row only when there is one to fill.
 *
 * `CardHeader` is a grid. It used to declare `grid-rows-[auto_auto]`
 * unconditionally, so a card with a title and no `CardDescription` carried an
 * empty second track and drew the header's `gap-2` against it. Together with the
 * Card's own `gap-4 md:gap-6` that made the distance from a heading to its body
 * 32 px on desktop where 24 px was intended. It was visible, it was reported, and
 * it affected 45 of the 48 files that mount a `CardHeader`.
 *
 * Two class declarations have to agree for the fix to hold:
 *
 *   1. the second row is conditional on a description being present, and
 *   2. `CardAction` spans the full row set rather than a hard-coded two.
 *
 * The second one is the trap. `row-span-2` against a single explicit row mints
 * an implicit second row, which brings the gap straight back for every header
 * that carries an action but no description. Reverting it produces no test
 * failure anywhere else in the suite, because nothing asserts a `row-span`
 * class: the regression is DOM geometry, which the unit tests cannot see.
 *
 * So this file is the guard. It is deliberately a literal-class assertion, the
 * same shape `assessment-spine-order.test.ts` already uses, because the question
 * has an exact answer and an exact answer belongs in a gate rather than in a
 * reviewer's memory.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(process.cwd(), "src/components/ui/card.tsx"),
  "utf8",
);

describe("CardHeader row reservation", () => {
  it("reserves the second row only when a description is present", () => {
    expect(SOURCE).toContain(
      "has-data-[slot=card-description]:grid-rows-[auto_auto]",
    );
  });

  it("never declares the second row unconditionally", () => {
    // The unconditional form is what drew the phantom gap. It may only ever
    // appear behind the `has-data-[slot=card-description]:` variant, so the bare
    // token must not occur on its own.
    const bare = SOURCE.replace(
      /has-data-\[slot=card-description\]:grid-rows-\[auto_auto\]/g,
      "",
    );
    expect(bare).not.toContain("grid-rows-[auto_auto]");
  });
});

describe("CardAction row span", () => {
  it("spans the full row set rather than a hard-coded two", () => {
    // `row-span-2` would mint an implicit second row in a description-less
    // header and resurrect the gap the header fix just removed.
    expect(SOURCE).toContain("row-span-full");
    expect(SOURCE).not.toContain("row-span-2");
  });
});
