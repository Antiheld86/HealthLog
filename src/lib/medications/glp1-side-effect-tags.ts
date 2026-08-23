/**
 * The GLP-1 side-effect tag catalogue — isomorphic half.
 *
 * A mood entry carries two tag axes: the structured `MoodEntryTagLink`
 * taxonomy, and the flat free-text `MoodEntry.tags` column. The GLP-1
 * side-effect chips in the mood form write onto the FLAT axis, and they write
 * `t(labelKey)` — the label in whatever language the writer's UI was in. So
 * the column holds "nausea" for an English account and "Nudności" for a Polish
 * one, for the same recorded symptom.
 *
 * The chips are nonetheless a CLOSED set with stable keys. That is the whole
 * point of this module: the timeline, the Coach snapshot and the doctor report
 * used to match the stored label against a hand-written English/German word
 * list, which meant a French, Spanish, Italian or Polish account recorded a
 * side effect and every downstream surface counted zero. Matching the label
 * was the defect; the key is the fix.
 *
 * This file holds only what a browser may also need — the key set and each
 * key's label key, so the PDF renderer can print a canonical key in the
 * reader's language. The label → key direction needs every locale's bundle and
 * therefore lives server-side in `./glp1-side-effect-tag-match`.
 */

/**
 * The catalogue, in display order. `key` is the stable machine value that
 * crosses the API and the Coach prompt; `labelKey` is the i18n key the chip
 * renders and — through the six bundles — the set of strings that can appear
 * in the stored column.
 *
 * Adding an entry here is a product decision about what the capture UI asks:
 * the strip is deliberately short, covering the symptoms clinicians ask about
 * at a GLP-1 follow-up. Adding a LOCALE, by contrast, needs no edit here at
 * all — the matcher reads whatever `messages/<locale>.json` says.
 *
 * The Coach's own copy of the old word list also carried `vomiting`, `reflux`
 * and `erbrechen`. Those are gone on purpose. No chip writes them, so they
 * only ever matched a hand-typed tag, and only in English and German — an
 * English speaker who typed "vomiting" got a line and an Italian who typed
 * "vomito" did not. Keeping them would have rebuilt the defect inside its own
 * fix. Bringing either symptom back means giving it a chip and a label in all
 * six bundles, which is the product decision above.
 */
export const GLP1_SIDE_EFFECT_TAGS = [
  { key: "nausea", labelKey: "medications.sideEffectTagNausea" },
  { key: "constipation", labelKey: "medications.sideEffectTagConstipation" },
  { key: "diarrhea", labelKey: "medications.sideEffectTagDiarrhea" },
  { key: "fatigue", labelKey: "medications.sideEffectTagFatigue" },
  { key: "appetite-loss", labelKey: "medications.sideEffectTagAppetiteLoss" },
  { key: "heartburn", labelKey: "medications.sideEffectTagHeartburn" },
  { key: "headache", labelKey: "medications.sideEffectTagHeadache" },
] as const;

/** Stable machine key of a catalogue side effect. */
export type Glp1SideEffectTag = (typeof GLP1_SIDE_EFFECT_TAGS)[number]["key"];

/** Catalogue order, for callers that only need the keys. */
export const GLP1_SIDE_EFFECT_TAG_KEYS: readonly Glp1SideEffectTag[] =
  GLP1_SIDE_EFFECT_TAGS.map((t) => t.key);

/**
 * Key → i18n label key. Every surface that shows a canonical key to a person
 * (the doctor-report PDF, any client rendering the timeline) resolves it
 * through here so the reader sees their own language rather than the language
 * the tag happened to be typed in.
 */
export const GLP1_SIDE_EFFECT_TAG_LABEL_KEYS: Record<
  Glp1SideEffectTag,
  string
> = Object.fromEntries(
  GLP1_SIDE_EFFECT_TAGS.map((t) => [t.key, t.labelKey]),
) as Record<Glp1SideEffectTag, string>;

/**
 * Fold a tag string to its comparison form.
 *
 * Applied identically to the stored tag and to every catalogue label, so the
 * two only have to agree up to case, accents and separators. That tolerance is
 * what lets "Perte d'appétit" typed with a straight quote match the bundle's
 * "Perte d’appétit", and "ubelkeit" match "Übelkeit" — without it the matcher
 * would be exact-string again, one keyboard away from the defect it replaces.
 *
 * Note the tolerance is one-directional folding, not transliteration: German
 * "ue" for "ü" does not fold to the same form, and the Polish ł is a single
 * codepoint that NFD leaves alone. Both are fine — the label the chip wrote is
 * the label the matcher indexes.
 */
export function normaliseSideEffectTag(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u02bc'`]/g, " ")
    .replace(/[-_/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read the flat `MoodEntry.tags` column.
 *
 * The column carries either a JSON array (mood-form writes) or a
 * comma-separated list (legacy imports). Be permissive — this used to be
 * copy-pasted into all three readers, which is how their tag vocabularies
 * drifted apart in the first place.
 */
export function parseMoodTagList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter(Boolean);
    }
  } catch {
    /* fall through to the CSV form */
  }
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}
