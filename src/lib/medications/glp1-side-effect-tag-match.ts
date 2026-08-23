/**
 * The GLP-1 side-effect tag catalogue — server-only matching half.
 *
 * Turns a stored flat mood tag back into the catalogue key it was written
 * from, in any locale the app ships.
 *
 * The index is DERIVED from `messages/<locale>.json`, not transcribed from it.
 * That is the load-bearing part. The three readers this replaces each carried
 * their own hand-written word list, covering English and German because those
 * were the two languages the maintainer typed in; the four other shipped
 * locales silently matched nothing, and the three lists had already drifted
 * apart from each other. A transcription would fix today's four locales and
 * reopen the same hole the day a seventh is added. Reading the bundles means a
 * new locale needs no edit in this file — `locales` grows, `messages/xx.json`
 * lands, and the labels that ship in it are matchable the same day.
 *
 * `allMessages` statically imports all six bundles and is SERVER-ONLY: do not
 * import this module from a client component. The three callers (the timeline
 * route, the Coach snapshot builder, the doctor-report aggregator) all run on
 * the server. A browser that needs to render a key resolves it through
 * `GLP1_SIDE_EFFECT_TAG_LABEL_KEYS` in the isomorphic half instead.
 *
 * Known limit, stated rather than engineered around: the index is built from
 * the labels a bundle carries TODAY, and it is applied to tags written in the
 * past. Editing a shipped translation therefore orphans the rows written under
 * the old wording. If a label has to change, keep the old string reachable —
 * the fix is a legacy alias here, not a data migration.
 */
import { locales } from "@/lib/i18n/config";
import { allMessages, resolveKey } from "@/lib/i18n/shared-resolve";
import {
  GLP1_SIDE_EFFECT_TAGS,
  normaliseSideEffectTag,
  parseMoodTagList,
  type Glp1SideEffectTag,
} from "./glp1-side-effect-tags";

/**
 * Normalised label (and canonical key) → catalogue key, across every shipped
 * locale. Built once at module load: 7 entries × 6 bundles is a handful of
 * string folds, and the bundles are already resident for the server
 * translator.
 *
 * Two locales spelling one catalogue entry the same way ("Constipation" in
 * English and French) is expected and folds onto one row. Two DIFFERENT
 * entries folding together would be a bundle bug; it resolves first-wins here
 * — a typo must not take down every GLP-1 surface at boot — and the guard
 * suite fails on it through `glp1SideEffectTagIndex()`.
 */
function buildIndex(): Map<string, Glp1SideEffectTag> {
  const index = new Map<string, Glp1SideEffectTag>();
  for (const { key, labelKey } of GLP1_SIDE_EFFECT_TAGS) {
    // The canonical key itself, so a client or importer that already speaks
    // keys round-trips without going through a label.
    index.set(normaliseSideEffectTag(key), key);
    for (const locale of locales) {
      const label = resolveKey(allMessages[locale], labelKey);
      if (!label) continue;
      const folded = normaliseSideEffectTag(label);
      if (!folded || index.has(folded)) continue;
      index.set(folded, key);
    }
  }
  return index;
}

const TAG_INDEX = buildIndex();

/**
 * Test seam: the guard suite asserts the index covers every locale and that no
 * two catalogue entries fold together. Production reads `TAG_INDEX` directly.
 */
export function glp1SideEffectTagIndex(): ReadonlyMap<
  string,
  Glp1SideEffectTag
> {
  return TAG_INDEX;
}

/**
 * A single stored tag → its catalogue key, or `null` when the tag is not a
 * catalogue side effect.
 *
 * `null` is the honest answer for genuine free text ("gym", "date night"):
 * those are mood tags, not side effects, and admitting them would invent
 * symptoms in a doctor's report. What can no longer produce `null` is a tag
 * the app's own chip strip wrote, in any shipped language.
 */
export function resolveGlp1SideEffectTag(
  raw: string,
): Glp1SideEffectTag | null {
  return TAG_INDEX.get(normaliseSideEffectTag(raw)) ?? null;
}

/** What one `MoodEntry.tags` column contributed. */
export interface Glp1SideEffectTagMatch {
  /** Catalogue keys found, deduplicated, in the order they were written. */
  matched: Glp1SideEffectTag[];
  /**
   * How many tags on the row were not catalogue entries. Carried so callers
   * can report the miss rate instead of dropping the tags without trace; it is
   * a COUNT and never the tag text, because the text is the user's own prose
   * and these surfaces (a therapy timeline, a clinician PDF, a model prompt)
   * are exactly where it must not turn up uninvited.
   */
  unresolvedCount: number;
}

/** Parse a stored tags column and resolve every tag on it. */
export function matchGlp1SideEffectTags(
  rawTagsColumn: string | null | undefined,
): Glp1SideEffectTagMatch {
  const matched: Glp1SideEffectTag[] = [];
  let unresolvedCount = 0;
  for (const raw of parseMoodTagList(rawTagsColumn)) {
    const key = resolveGlp1SideEffectTag(raw);
    if (!key) {
      unresolvedCount += 1;
      continue;
    }
    if (!matched.includes(key)) matched.push(key);
  }
  return { matched, unresolvedCount };
}
