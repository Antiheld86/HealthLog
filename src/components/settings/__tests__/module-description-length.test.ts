import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MODULE_KEYS } from "@/lib/modules/registry";
import { locales } from "@/lib/i18n/config";

/**
 * A module row in the "What you track" hub gets ONE sentence, same as a card
 * header's description slot (design standards §3).
 *
 * Five of the eighteen rows had grown a second sentence — always the same
 * one, "Off by default", and in one case a third clause after it. The
 * neighbours sat at 30-75 characters and those five at 120-165, so the hub
 * read as two different lists stacked on each other. The switch beside the
 * row already says whether the module is on, so the sentence was restating
 * what the control shows.
 *
 * The single-sentence half of the rule is checked in every locale: it is a
 * structural claim, not a length one, and a translation that re-adds the
 * clause is the same defect. The character cap is checked in EN and DE, the
 * two the maintainer reads, matching `card-description-length.test.ts`.
 */

const ROOT = process.cwd();
const MAX_CHARS = 120;

function bundle(locale: string): Record<string, { description?: string }> {
  const raw = readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8");
  return JSON.parse(raw).modules;
}

describe("module hub descriptions", () => {
  it("names a description for every module in every locale", () => {
    // Positive control: without it, a renamed `modules` namespace would make
    // the two checks below iterate an empty set and report green.
    for (const locale of locales) {
      const modules = bundle(locale);
      const missing = MODULE_KEYS.filter(
        (key) => !modules[key]?.description?.trim(),
      );
      expect(missing, `${locale} is missing descriptions`).toEqual([]);
    }
  });

  it("holds each one to a single sentence, in every locale", () => {
    const offenders: string[] = [];
    for (const locale of locales) {
      const modules = bundle(locale);
      for (const key of MODULE_KEYS) {
        const text = modules[key].description!;
        // Drop the closing terminator, then any sentence break left inside
        // is a second sentence. A semicolon splice counts — it is how the
        // longest of the five carried its third clause.
        const body = text.replace(/[.!?…]\s*$/, "");
        if (/[.!?;]\s/.test(body)) {
          offenders.push(`${locale}/${key}: ${text}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("holds each one under the character guideline in EN and DE", () => {
    const offenders: string[] = [];
    for (const locale of ["en", "de"] as const) {
      const modules = bundle(locale);
      for (const key of MODULE_KEYS) {
        const text = modules[key].description!;
        if (text.length > MAX_CHARS) {
          offenders.push(`${locale}/${key}: ${text.length} chars`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
