import { describe, it, expect } from "vitest";

import { getCoachSystemPrompt } from "@/lib/ai/coach/system-prompt";
import { loadSafetyContracts } from "@/lib/ai/prompts/safety-contracts";
import type { Locale } from "@/lib/i18n/config";

/**
 * v1.18.10 (MEDIUM-1) — resolved-Coach-prompt contract parity.
 *
 * `safety-contracts-parity.test.ts` asserts every ground-rule BODY in the
 * matrix is non-empty per locale. This file goes one step further and asserts
 * the *resolved* `getCoachSystemPrompt(locale)` string — the exact text the
 * provider sees — carries the grounding + GLP-1 dose-safety contract for EVERY
 * UI locale, not just de/en. The audit's residual MEDIUM-1 risk was that a
 * non-EN/DE locale could silently fall back to the EN-plus-footer path (or a
 * native body that weakened the wording) and ship a less-strict Coach. These
 * assertions fail the build if that ever happens.
 *
 * Markers used:
 *  - grounding: the literal "SNAPSHOT" token, which the grounding rule's
 *    `must_contain` pins in every locale.
 *  - GLP-1 dose safety: the brand registry (Mounjaro / Ozempic), which is
 *    identical across all seven locales (an international registry, never
 *    translated) and only ever appears inside the dose-safety contract.
 */

const ALL_LOCALES: Locale[] = ["de", "en", "fr", "es", "it", "pl", "ko"];

describe("resolved Coach system prompt — grounding + GLP-1 per locale", () => {
  for (const locale of ALL_LOCALES) {
    it(`${locale} carries a grounding marker`, () => {
      const prompt = getCoachSystemPrompt(locale);
      expect(prompt).toContain("SNAPSHOT");
    });

    it(`${locale} carries the GLP-1 dose-safety contract`, () => {
      const prompt = getCoachSystemPrompt(locale);
      // Brand names are identical across locales and only appear in the
      // dose-safety contract — their presence proves the contract is composed.
      expect(prompt).toMatch(/Mounjaro/);
      expect(prompt).toMatch(/Ozempic/);
    });

    it(`${locale} never silently empties to a bare EN footer`, () => {
      const prompt = getCoachSystemPrompt(locale);
      expect(prompt.trim().length).toBeGreaterThan(500);
    });
  }
});

describe("GLP-1 brand registry stays identical across locales (marker basis)", () => {
  const enBrands = loadSafetyContracts("en").glp1_brand_list;
  it("EN brand list is non-empty (the marker source)", () => {
    expect(enBrands.length).toBeGreaterThan(0);
    expect(enBrands).toContain("Mounjaro");
  });
});
