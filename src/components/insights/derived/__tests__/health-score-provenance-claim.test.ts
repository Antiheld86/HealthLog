/**
 * v1.35.0 — the Health Score's composite-level provenance must not claim
 * more than it does.
 *
 * Two sentences used to overreach, in different ways.
 *
 * The one people read, `insights.healthScore.method`, said the score was
 * the average of "every pillar that has enough recent data". Once somebody
 * can take a pillar out of their score, that is simply untrue for them,
 * and it is untrue in the direction that matters: it tells them the number
 * covers ground it does not. The replacement says the average is over the
 * pillars that count, and that which pillars count is theirs to choose.
 * This test pins the choice sentence in all six locales, because a
 * translation that quietly drops it puts the old claim back for those
 * readers only.
 *
 * The one nobody reads, `METRIC_PROVENANCE.HEALTH_SCORE.standard`, named
 * the WHO HEARTS technical package flat, as though a standards body had
 * signed off on whatever recipe the account happens to hold. HEARTS names
 * the risk factors; it prescribes no average over them. The entry now says
 * what it is cited for. It reaches no screen today (`ProvenanceExplainer`
 * renders the method caption only), which is exactly why the method copy
 * above carries the honesty and this half is a source-of-truth fix.
 *
 * The marker check is deliberately blunt, and blunt has a failure mode: a
 * substring test can pass on prose that means nothing. So it is pinned in
 * both directions here, against the wording this release replaced and
 * against a rewrite that keeps the meaning, before it is trusted on the
 * real bundles.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { METRIC_PROVENANCE } from "../standards";

const MESSAGES = join(__dirname, "../../../../../messages");

/**
 * The phrase in each locale that says the selection belongs to the
 * reader. Not a stylistic preference: it is the sentence that stops the
 * paragraph from describing a fixed recipe.
 */
const SCOPE_MARKER: Record<string, string> = {
  en: "yours to choose",
  de: "entscheidest du",
  fr: "vous choisissez",
  es: "lo eliges tú",
  it: "lo scegli tu",
  pl: "ty decydujesz",
};

/** The wording this release replaced, kept only to prove the check bites. */
const PRE_V1350_EN =
  "The score is the equal-weighted average of every pillar that has enough " +
  "recent data, on a 0 to 100 scale.";

/** An honest rewrite that keeps the meaning, to prove the check is quiet. */
const INNOCENT_EN_REWRITE =
  "Pillars are averaged with equal weight on a 0 to 100 scale, and which " +
  "pillars count is yours to choose.";

function methodCopy(locale: string): string {
  const bundle = JSON.parse(
    readFileSync(join(MESSAGES, `${locale}.json`), "utf8"),
  ) as {
    insights: { healthScore: { method: string } };
  };
  return bundle.insights.healthScore.method;
}

function claimsPersonalScope(locale: string, text: string): boolean {
  const marker = SCOPE_MARKER[locale];
  if (!marker) throw new Error(`no scope marker declared for ${locale}`);
  return text.toLocaleLowerCase().includes(marker.toLocaleLowerCase());
}

describe("Health Score provenance claims", () => {
  it("bites on the wording this release replaced", () => {
    expect(claimsPersonalScope("en", PRE_V1350_EN)).toBe(false);
  });

  it("stays quiet on a rewrite that keeps the meaning", () => {
    expect(claimsPersonalScope("en", INNOCENT_EN_REWRITE)).toBe(true);
  });

  it.each(Object.keys(SCOPE_MARKER))(
    "says in %s that the pillars in scope are the reader's own",
    (locale) => {
      const copy = methodCopy(locale);
      expect(copy.length).toBeGreaterThan(0);
      expect(claimsPersonalScope(locale, copy)).toBe(true);
    },
  );

  it("does not cite a standard as describing the composite", () => {
    const { name } = METRIC_PROVENANCE.HEALTH_SCORE.standard;
    // The bare package title read as an endorsement of the account's own
    // recipe. It is cited for the risk factors the pillars are drawn from,
    // and the name has to say so.
    expect(name).not.toBe("WHO HEARTS technical package");
    expect(name).toContain("risk-factor set");
  });
});
