/**
 * v1.28 — banned-verb guard for the `medications.efficacy.*` namespace.
 *
 * The medication-efficacy view ("Wirkung") is a medication-adjacent claim, so
 * its safety boundary is structural, not left to reviewer vigilance: the DTO
 * carries no verdict / score field, and the copy must stay strictly
 * descriptive — an association, never "the drug works / is effective", never a
 * dose change. This test walks every efficacy string in all six locales and
 * fails if any value contains a verdict or dose-advice verb, so a forbidden
 * word can never creep into the bundle. Mirrors the `i18n-english-leak-guard`
 * flatten + filter + `toEqual([])` pattern.
 *
 * If this fails: rewrite the offending string to descriptive phrasing (numbers
 * + neutral connectives). Do NOT weaken the denylist to pass.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const MESSAGES = join(__dirname, "..", "..", "messages");
const LOCALES = readdirSync(MESSAGES).filter((f) => f.endsWith(".json"));

/** Verdict + efficacy-adjective + dose-advice verbs across the six locales. */
const BANNED: RegExp[] = [
  // English
  /\bworks?\b/i,
  /\bworking\b/i,
  /\beffective(ly)?\b/i,
  /\bineffective\b/i,
  /\bcures?\b/i,
  /\bcured\b/i,
  /\bheals?\b/i,
  /\bhealed\b/i,
  /\bimprove(d|s|ment)?\b/i,
  /\bworsen(ed|s)?\b/i,
  /\bbetter\b/i,
  /\bworse\b/i,
  /\bincrease\b/i,
  /\bdecrease\b/i,
  /\breduce\b/i,
  /\braise\b/i,
  /\bsuccess(ful)?\b/i,
  // German
  /\bwirksam\b/i,
  /\bunwirksam\b/i,
  /\banschlägt\b/i,
  /\bheilt\b/i,
  /\bverbessert\b/i,
  /\bverschlechtert\b/i,
  /\berhöhen\b/i,
  /\bsenken\b/i,
  /\babsetzen\b/i,
  // Spanish
  /\bfunciona\b/i,
  /\beficaz\b/i,
  /\bineficaz\b/i,
  /\bmejora\b/i,
  /\bempeora\b/i,
  // French
  /\befficace\b/i,
  /\binefficace\b/i,
  /\baméliore\b/i,
  /\baggrave\b/i,
  // Italian
  /\bmigliora\b/i,
  /\bpeggiora\b/i,
  // Polish
  /\bskuteczn\w*\b/i,
  /\bpoprawia\b/i,
  /\bpogarsza\b/i,
];

function flatten(obj: unknown, prefix: string, out: [string, string][]): void {
  if (obj === null || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push([key, v]);
    else flatten(v, key, out);
  }
}

describe("medications.efficacy — banned verdict/advice verbs", () => {
  // Six shipped locales. An empty read of `messages/` would register zero
  // per-locale cases and the suite would report green over nothing.
  it("reads every shipped locale bundle", () => {
    expect(LOCALES.length).toBeGreaterThanOrEqual(6);
  });

  it.each(LOCALES)("%s carries no forbidden verb", (file) => {
    const bundle = JSON.parse(readFileSync(join(MESSAGES, file), "utf8")) as {
      medications?: { efficacy?: unknown };
    };
    const efficacy = bundle.medications?.efficacy;
    expect(efficacy, `${file} is missing medications.efficacy`).toBeDefined();

    const flat: [string, string][] = [];
    flatten(efficacy, "medications.efficacy", flat);
    expect(flat.length).toBeGreaterThan(0);

    const violations = flat
      .filter(([, value]) => BANNED.some((re) => re.test(value)))
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);

    expect(
      violations,
      `Forbidden verdict/advice verb in ${file} — the efficacy view is ` +
        `association-only. Rewrite to descriptive phrasing:\n` +
        violations.map((v) => `  ${v}`).join("\n"),
    ).toEqual([]);
  });
});
