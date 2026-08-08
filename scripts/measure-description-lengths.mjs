/**
 * Measures the description / hint strings under the `settings` and `admin`
 * namespaces against the design standards' §3 rule: one sentence, guideline
 * ≤ 120 characters.
 *
 *   node scripts/measure-description-lengths.mjs [locale=de] [--top N]
 *
 * A review tool, not a gate — the gate is
 * `src/components/settings/__tests__/card-description-length.test.ts`, which
 * checks the strings that actually reach a card header's description slot.
 * This one sweeps wider so a long hint in a body still shows up in a sweep.
 */
import { readFileSync } from "node:fs";

const locale = process.argv[2]?.startsWith("--")
  ? "de"
  : (process.argv[2] ?? "de");
const topIdx = process.argv.indexOf("--top");
const top = topIdx === -1 ? 40 : Number(process.argv[topIdx + 1]);

const NAME = /(description|subtitle|hint|note|explainer|help|body)$/i;

function walk(node, path, out) {
  for (const [key, value] of Object.entries(node)) {
    const next = path ? `${path}.${key}` : key;
    if (typeof value === "string") {
      if (NAME.test(key)) out.push([next, value]);
    } else if (value && typeof value === "object") {
      walk(value, next, out);
    }
  }
}

/** Sentence count: terminators followed by a space + capital, or at the end. */
function sentences(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const matches = trimmed.match(/[.!?](\s+[^\s]|$)/g);
  return Math.max(1, matches ? matches.length : 1);
}

const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));
const entries = [];
for (const ns of ["settings", "admin"]) {
  if (bundle[ns]) walk(bundle[ns], ns, entries);
}

const lengths = entries.map(([, v]) => v.length).sort((a, b) => a - b);
const at = (q) =>
  lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * q))];
const multi = entries.filter(([, v]) => sentences(v) >= 2);

console.log(`locale ${locale} — ${entries.length} description/hint strings`);
console.log(
  `length: min ${lengths[0]}, median ${at(0.5)}, p75 ${at(0.75)}, p90 ${at(0.9)}, max ${lengths.at(-1)}`,
);
console.log(
  `> 120 chars: ${lengths.filter((n) => n > 120).length}, > 200: ${lengths.filter((n) => n > 200).length}`,
);
console.log(
  `>= 2 sentences: ${multi.length}, >= 3: ${entries.filter(([, v]) => sentences(v) >= 3).length}`,
);
console.log(`\nLONGEST ${top}:`);
for (const [key, value] of [...entries]
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, top)) {
  console.log(
    `${String(value.length).padStart(4)}ch ${sentences(value)}S ${key}`,
  );
  console.log(`  ${value.slice(0, 130)}${value.length > 130 ? "…" : ""}`);
}
