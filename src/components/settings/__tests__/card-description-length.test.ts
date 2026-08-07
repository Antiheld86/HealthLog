import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The description slot holds ONE sentence, guideline ≤ 120 characters
 * (design standards §3).
 *
 * Scope is deliberately the strings that actually reach a card header's
 * description slot — `<SettingsCardHeader description={t("…")}>` — because
 * that is the slot the rule is about. A hint in a card body is prose and is
 * allowed to be prose; `scripts/measure-description-lengths.mjs` sweeps those
 * for review without gating them.
 *
 * Both EN and DE are checked. DE runs 15-25% longer than EN, and a rule that
 * only holds in English produces a slot that wraps to two lines in half the
 * locales — which is the same defect, moved.
 */

const ROOT = process.cwd();
const MAX_CHARS = 120;

/**
 * Strings that stay longer than the guideline, each with the reason. The
 * guideline is not a hard cut: a sentence that needs 130 characters to stay
 * true is fine. Two sentences never are, and that half of the rule has no
 * exceptions.
 */
const LENGTH_EXCEPTIONS: Record<string, string> = {
  // Empty on purpose: the sweep that introduced this guard left nothing over
  // the guideline in EN or DE. An entry here needs a sentence saying what the
  // extra characters buy, and `carries no stale exception` deletes it again
  // the moment the string fits or stops being a description.
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(full, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Every `description={t("…")}` inside a `<SettingsCardHeader …>` element. */
function describedKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (const dir of ["settings", "admin", "measurement-reminders"]) {
    for (const file of walk(join(ROOT, "src", "components", dir))) {
      const source = readFileSync(file, "utf8");
      const header = /<SettingsCardHeader\b/g;
      let match: RegExpExecArray | null;
      while ((match = header.exec(source))) {
        // The element ends at the first `/>` or `>` that closes the opening
        // tag; a `description={t("x")}` after that belongs to something else.
        const end = source.indexOf("/>", match.index);
        const slice = source.slice(match.index, end === -1 ? undefined : end);
        const desc = /description=\{t\(\s*"([^"]+)"/.exec(slice);
        if (!desc) continue;
        const list = keys.get(desc[1]) ?? [];
        list.push(file.slice(ROOT.length + 1));
        keys.set(desc[1], list);
      }
    }
  }
  return keys;
}

function resolve(bundle: unknown, key: string): string | undefined {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      bundle,
    );
  return typeof value === "string" ? value : undefined;
}

/** Sentence terminators followed by a space or the end of the string. */
function sentenceCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const matches = trimmed.match(/[.!?](\s+\S|$)/g);
  return Math.max(1, matches ? matches.length : 1);
}

describe("card header descriptions — one sentence, ≤120 characters", () => {
  const keys = describedKeys();

  it("finds the description slots it is meant to check", () => {
    // A matcher that quietly matches nothing passes every assertion below it.
    expect(keys.size).toBeGreaterThan(25);
  });

  for (const locale of ["en", "de"] as const) {
    const bundle = JSON.parse(
      readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8"),
    );

    it(`${locale}: every description is a single sentence`, () => {
      const offenders: string[] = [];
      for (const [key, files] of keys) {
        const value = resolve(bundle, key);
        if (value === undefined) continue; // the i18n coverage guard owns this
        if (sentenceCount(value) > 1) {
          offenders.push(
            `${key} (${sentenceCount(value)} sentences) — ${files[0]}`,
          );
        }
      }
      expect(offenders).toEqual([]);
    });

    it(`${locale}: every description is within the length guideline`, () => {
      const offenders: string[] = [];
      for (const [key, files] of keys) {
        const value = resolve(bundle, key);
        if (value === undefined) continue;
        if (value.length > MAX_CHARS && !(key in LENGTH_EXCEPTIONS)) {
          offenders.push(`${key} (${value.length} chars) — ${files[0]}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it("carries no stale exception", () => {
    const bundle = JSON.parse(
      readFileSync(join(ROOT, "messages", "en.json"), "utf8"),
    );
    for (const [key, reason] of Object.entries(LENGTH_EXCEPTIONS)) {
      expect(
        keys.has(key),
        `${key} is allowlisted but no longer a description`,
      ).toBe(true);
      expect(
        resolve(bundle, key)!.length,
        `${key} is allowlisted but now fits the guideline`,
      ).toBeGreaterThan(MAX_CHARS);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
