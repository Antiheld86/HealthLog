/**
 * Match indexes derived from the shipped message bundles.
 *
 * The recurring defect this closes: a resolver that has to turn a
 * user-authored word ("Fer", "Żelazo", "Sommeil") into an internal code
 * transcribes the ENGLISH display names into a hand-typed table in the
 * source. Five of the six shipped locales then resolve to nothing, even
 * though their translations are already on disk in `messages/<locale>.json`
 * and are already what the app renders for the same concept.
 *
 * The fix is to stop transcribing. A caller names the i18n key that already
 * labels the concept; this module reads that key out of EVERY entry in
 * `locales` and builds the folded-name → value index. Adding a locale to
 * `locales` and shipping its bundle is then the whole change — no edit here,
 * and no edit at any call site.
 *
 * SERVER-ONLY, like `shared-resolve` (whose `allMessages` it reads): pulling
 * this into a client chunk would drag all six catalogs back in. Both current
 * consumers are MCP reads, which are server-side by construction.
 *
 * Deliberately NOT a translation layer for OUTPUT. The MCP surface answers in
 * protocol-level English on purpose (see `nutrients-read.ts` and the
 * `metric-status-registry`'s `displayName` comment); this module only widens
 * what the resolver ACCEPTS.
 */
import { locales, type Locale } from "./config";
import { allMessages, resolveKey } from "./shared-resolve";

/**
 * Letters Unicode decomposition leaves alone because their mark is part of
 * the glyph rather than a combining character — a stroke, or a ligature. NFKD
 * turns "ż" into "z" + a dot but leaves "ł" whole, so Polish would fold half
 * way without this. Expressed as ASCII equivalents, the same target the
 * combining-mark strip below produces.
 */
const UNDECOMPOSED_LETTERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ł/g, "l"],
  [/ø/g, "o"],
  [/đ/g, "d"],
  [/ß/g, "ss"],
  [/æ/g, "ae"],
  [/œ/g, "oe"],
];

/**
 * Fold a label or a free-text term to its match form: compatibility-normalised
 * (so "VO₂" and "VO2" agree), diacritics stripped (so "Glycémie" answers to
 * "glycemie" and "Siła" to "sila"), lower-cased, and every run of
 * non-alphanumerics collapsed to a single `_` with the ends trimmed (so
 * "Pain (0–10)" and "pain 0 10" agree).
 *
 * Applied to BOTH sides of every comparison — a bundle label and the caller's
 * word go through the same function, so the index cannot drift from the lookup.
 */
export function foldLabel(raw: string): string {
  let folded = raw
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  for (const [pattern, ascii] of UNDECOMPOSED_LETTERS) {
    folded = folded.replace(pattern, ascii);
  }
  return folded.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/gu, "");
}

/** One locale's rendering of `key`, or `null` when that bundle omits it. */
export function labelIn(locale: Locale, key: string): string | null {
  const value = resolveKey(allMessages[locale], key);
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Every shipped locale's rendering of `key`, skipping bundles that omit it. */
export function labelsInEveryLocale(key: string): string[] {
  const out: string[] = [];
  for (const locale of locales) {
    const label = labelIn(locale, key);
    if (label !== null) out.push(label);
  }
  return out;
}

/** One concept: a stable identity, the i18n key that labels it, its payload. */
export interface LocalisedLabelEntry<T> {
  /**
   * Stable identity of the concept. Two entries sharing an id are the same
   * thing (a label they both fold to is not an ambiguity); two entries with
   * DIFFERENT ids that fold to one string are, and the string is dropped.
   */
  id: string;
  /** The i18n key whose per-locale renderings become accepted spellings. */
  messageKey: string;
  /** What a match resolves to. */
  value: T;
}

export interface LocalisedLabelIndex<T> {
  /** Folded label → value. Ambiguous folds are absent, never guessed. */
  index: ReadonlyMap<string, T>;
  /**
   * Folds two different ids both claimed. Dropped from `index` rather than
   * resolved to whichever entry happened to be built first — a resolver that
   * guesses between two concepts is worse than one that answers "not
   * recognised". Consumers assert this is empty.
   */
  ambiguous: ReadonlySet<string>;
}

/**
 * Build the folded-label → value index across every shipped locale.
 *
 * A bundle that omits an entry's key simply contributes nothing for that
 * locale — a partially translated bundle degrades to the locales that do
 * carry the key instead of failing the module load.
 */
export function buildLocalisedLabelIndex<T>(
  entries: readonly LocalisedLabelEntry<T>[],
): LocalisedLabelIndex<T> {
  const index = new Map<string, T>();
  const owner = new Map<string, string>();
  const ambiguous = new Set<string>();

  for (const entry of entries) {
    for (const label of labelsInEveryLocale(entry.messageKey)) {
      const folded = foldLabel(label);
      if (folded === "") continue;
      const claimed = owner.get(folded);
      if (claimed === undefined) {
        owner.set(folded, entry.id);
        index.set(folded, entry.value);
        continue;
      }
      if (claimed === entry.id) continue;
      ambiguous.add(folded);
      index.delete(folded);
    }
  }

  return { index, ambiguous };
}
