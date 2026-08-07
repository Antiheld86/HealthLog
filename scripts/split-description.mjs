/**
 * Splits an over-long description at its first sentence boundary, in every
 * locale, WITHOUT retranslating anything: the tail is already written in each
 * language, it is just in the wrong slot.
 *
 *   node scripts/split-description.mjs --dry <key> [<key> …]
 *   node scripts/split-description.mjs drop <key> [<key> …]
 *   node scripts/split-description.mjs move <key> <tailKey>
 *
 *   drop  — the description keeps sentence 1; the tail is deleted.
 *   move  — the description keeps sentence 1; the tail lands under `tailKey`,
 *           to be rendered in the card body as foreground `text-sm`.
 *   --dry — print what each locale would become, change nothing.
 *
 * A terminator followed by whitespace and an upper-case letter (or a digit,
 * or an opening quote) is a sentence boundary. `Claude.ai` and `z. B.` do not
 * match: the first has no whitespace, the second continues lower-case.
 */
import { readFileSync, writeFileSync } from "node:fs";

const LOCALES = ["de", "en", "es", "fr", "it", "pl"];
const BOUNDARY = /(?<=[.!?])\s+(?=[A-ZÄÖÜÀÂÉÈÊÎÔÙÛÇŁŚŹŻĄĆĘŃÓ0-9„"„«])/u;

function get(bundle, path) {
  return path
    .split(".")
    .reduce((node, part) => (node == null ? node : node[part]), bundle);
}
function set(bundle, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  let node = bundle;
  for (const part of parts) {
    if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
    node = node[part];
  }
  node[last] = value;
}

const [mode, ...rest] = process.argv.slice(2);
const dry = mode === "--dry";
const keys = dry ? rest : mode === "move" ? [rest[0]] : rest;
const tailKey = mode === "move" ? rest[1] : null;
if (!mode || keys.length === 0) {
  console.error("usage: --dry|drop|move <key> [tailKey]");
  process.exit(1);
}

for (const locale of LOCALES) {
  const file = `messages/${locale}.json`;
  const bundle = JSON.parse(readFileSync(file, "utf8"));
  let changed = false;
  for (const key of keys) {
    const value = get(bundle, key);
    if (typeof value !== "string") {
      console.log(`${locale} ${key}: MISSING`);
      continue;
    }
    const parts = value.split(BOUNDARY);
    if (parts.length < 2) {
      console.log(`${locale} ${key}: single sentence, untouched`);
      continue;
    }
    const head = parts[0].trim();
    const tail = parts.slice(1).join(" ").trim();
    if (dry) {
      console.log(
        `${locale} ${key}\n  head(${head.length}): ${head}\n  tail: ${tail}`,
      );
      continue;
    }
    set(bundle, key, head);
    if (tailKey) set(bundle, tailKey, tail);
    changed = true;
  }
  if (changed) {
    writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    console.log(`${locale}: written`);
  }
}
