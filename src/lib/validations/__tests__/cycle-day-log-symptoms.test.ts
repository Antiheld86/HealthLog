import { describe, expect, it } from "vitest";

import {
  cycleDayLogInputSchema,
  cycleDayLogPatchSchema,
} from "@/lib/validations/cycle";

/**
 * A symptom picked without an intensity is the ordinary way to log one.
 *
 * The sheet holds the picker as key to intensity and sends `severity: null`
 * for every symptom the user did not rate, which is most of them. The schema
 * took a number or nothing at all, so those entries came back 422 and the
 * sheet showed "Could not save. Try again." with no way to tell why. The link
 * row has always stored an unrated symptom as a plain presence; only the
 * gate at the door disagreed, and nothing tested it.
 */
const BASE_INPUT = {
  date: "2026-09-17",
  loggedAt: new Date().toISOString(),
} as const;

describe("cycle day-log symptoms accept an unrated selection", () => {
  for (const [name, schema] of [
    ["create", cycleDayLogInputSchema],
    ["patch", cycleDayLogPatchSchema],
  ] as const) {
    it(`${name}: takes a symptom with no intensity at all`, () => {
      const parsed = schema.safeParse({
        ...BASE_INPUT,
        symptoms: [{ key: "cramps" }],
      });
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });

    it(`${name}: takes an explicit null intensity, which is what the sheet sends`, () => {
      const parsed = schema.safeParse({
        ...BASE_INPUT,
        symptoms: [
          { key: "cramps", severity: null },
          { key: "back_pain", severity: null },
        ],
      });
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });

    it(`${name}: still takes a rated symptom`, () => {
      const parsed = schema.safeParse({
        ...BASE_INPUT,
        symptoms: [{ key: "cramps", severity: 3 }],
      });
      expect(parsed.success).toBe(true);
    });

    it(`${name}: still refuses an intensity outside 1 to 4`, () => {
      for (const severity of [0, 5, 2.5]) {
        const parsed = schema.safeParse({
          ...BASE_INPUT,
          symptoms: [{ key: "cramps", severity }],
        });
        expect(parsed.success, `severity ${severity}`).toBe(false);
      }
    });
  }
});
