import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { inviteGrantSchema } from "@/lib/validations/account-sharing";
import {
  SETTINGS_DESTINATION_INVENTORY,
  isManageDelegateSettingsDestination,
} from "@/lib/record-settings/classification";

/**
 * What the product SAYS a manage grant cannot reach agrees with what it cannot
 * reach.
 *
 * Two sentences make that promise, and both were written when it was true:
 *
 *   * the `access` field's description in the sharing request schema, which is
 *     generated into `docs/api/openapi.yaml` and read by the native client —
 *     it said MANAGE "never reaches … settings";
 *   * `recordSharing.unavailable.description`, the paragraph a delegate meets
 *     on a page sharing does not cover — it said settings "stay with the
 *     person who owns the account".
 *
 * v1.37.0 opened one Settings destination to a manage grant, and both
 * sentences became false in the most expensive place a sentence can be false:
 * one is a consent screen, the other is a published contract. A promise that
 * has quietly stopped holding is worse than no promise, because somebody has
 * already decided based on it.
 *
 * So the copy is checked against the classification rather than against
 * itself. If a second destination is ever opened, or the anamnesis one is
 * closed again, the sentence that describes the boundary has to move with it.
 *
 * What this cannot check is whether the wording is GOOD. It checks that the
 * absolute claim is gone, that the boundary is named the way the code draws it
 * (record content versus account configuration), and that all six locales say
 * it — which is the part that rots silently.
 */
const ROOT = process.cwd();
const LOCALES = ["de", "en", "es", "fr", "it", "pl"] as const;

/** The published description of the level, off the Zod schema itself. */
function accessDescription(): string {
  const shape = (
    inviteGrantSchema as unknown as {
      _def: { shape: Record<string, { description?: string }> };
    }
  )._def.shape;
  return shape.access?.description ?? "";
}

function description(locale: string): string {
  const bundle = JSON.parse(
    readFileSync(join(ROOT, `messages/${locale}.json`), "utf8"),
  ) as {
    recordSharing: { unavailable: { description: string } };
  };
  return bundle.recordSharing.unavailable.description;
}

describe("the published boundary matches the one the code draws", () => {
  const openDestinations = Object.keys(SETTINGS_DESTINATION_INVENTORY).filter(
    isManageDelegateSettingsDestination,
  );

  it("has something to be wrong about", () => {
    // The pin every leg below rests on. With no manage-reachable destination
    // the old absolute sentence would have been true and this whole file would
    // be asserting a style preference.
    expect(openDestinations).not.toHaveLength(0);
    expect(openDestinations).toContain("anamnesis");
    expect(accessDescription().length).toBeGreaterThan(200);
  });

  it("does not claim a manage grant reaches no settings at all", () => {
    const published = accessDescription();
    // The exact clause that went stale, and the shape of any replacement for
    // it. `settings` may appear — it has to, to say which parts stay with the
    // owner — but not as part of a blanket denial.
    expect(published).not.toMatch(/never reaches[^.]*\bsettings\b/i);
    expect(published).not.toMatch(/no access to settings/i);
  });

  it("names the boundary the classification actually draws", () => {
    // Not a synonym check for its own sake: "record content versus account
    // configuration" IS the rule `isManageDelegateSettingsDestination`
    // implements, and a description that described some other boundary would
    // be a second, disagreeing specification.
    expect(accessDescription()).toMatch(
      /record content versus account configuration/i,
    );
    // And the destination that was opened is named, so a reader of the
    // contract can tell which part of the record it means.
    expect(accessDescription()).toMatch(/allergies, family history/i);
  });

  it("keeps the refusal paragraph honest in all six locales", () => {
    // The delegate-facing half. It is shown on a page sharing does NOT cover,
    // so a sentence that over-claims there is read at the exact moment
    // somebody is working out where the edge is.
    const missing: string[] = [];
    for (const locale of LOCALES) {
      const text = description(locale);
      expect(text.length, locale).toBeGreaterThan(40);
      // Every locale has to acknowledge the health background, because that
      // is the part the old sentence implicitly denied. Matched on the stem
      // rather than the English spelling, and short enough to survive the
      // accent: the section is "Anamnèse" in French and "Anamneza" in Polish,
      // so anything past "anamn" is already language-specific and a matcher
      // tuned to one of them reports the others as broken.
      if (!/anamn/i.test(text)) missing.push(locale);
      // And it must still say the account itself stays with its owner —
      // dropping that would fix one over-claim by removing the boundary.
      expect(text, locale).toMatch(/konto|account|compte|cuenta|konta|koncie/i);
    }
    expect(missing).toEqual([]);
  });
});
