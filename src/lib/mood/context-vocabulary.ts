/**
 * The closed vocabularies a mood entry's day context is written from.
 *
 * Four sections — work, contacts, leisure, a notable event — each with a small
 * fixed key list and a handful of numbers. Every key here becomes three
 * things at once: a string stored in somebody's row, six locale labels, and a
 * feature name any later analysis names in its output. Renaming one after it
 * has been stored means a data migration, six locale edits and a re-fit, so
 * the list is closed and lives in exactly one file. The Zod enums derive from
 * these arrays, which is what makes "a value the vocabulary does not name
 * cannot be stored" a structural property rather than a convention.
 *
 * What is deliberately NOT here:
 *
 *   * Sleep, activity and vitals. They already have a home, and a mood entry
 *     links to that home instead of asking a second time
 *     (`src/lib/mood/linked-context.ts`). A stored copy would drift the moment
 *     somebody corrected a sleep session.
 *   * Body symptoms. The illness module owns symptom capture and severity, and
 *     the mood surface links into it rather than growing a parallel form.
 *   * A productivity rating and a self-determination rating. Both were on the
 *     table and both were cut: every field a person can leave empty still
 *     costs a control, six translations and a model feature, and neither of
 *     those two earned that.
 *
 * Labels are neutral by rule. "Worked a regular day" is a fact; "worked too
 * much" is a judgement, and a judgement about somebody's day belongs to nobody
 * but them. Contact circles are groups of people and are never scored: how
 * many people somebody saw is not a good or a bad number, which is why the
 * quality of the contact is a separate field from the fact of it.
 */

/** Every numeric self-rating in the context shares the level-A 0-10 scale. */
export const CONTEXT_RATING_MIN = 0;
export const CONTEXT_RATING_MAX = 10;

/**
 * Minutes bound for the duration fields. A day holds 1440 of them, and a
 * bound is what keeps a mistyped digit from landing as a real answer that
 * then drags every average it touches.
 */
export const CONTEXT_MINUTES_MIN = 0;
export const CONTEXT_MINUTES_MAX = 1440;

/** How a notable event landed, from clearly bad to clearly good. */
export const CONTEXT_VALENCE_MIN = -5;
export const CONTEXT_VALENCE_MAX = 5;

/**
 * The shape of the working day. `off` covers every kind of not-working day —
 * a weekend, leave, sick leave — because the reason belongs to the modules
 * that own it, not to a mood entry.
 */
export const WORK_STATUS_KEYS = [
  "off",
  "partial",
  "regular",
  "overtime",
] as const;

/**
 * Who the day's contact was with. Multi-select: a day is rarely one circle.
 * `professional` is a therapist, a doctor, a counsellor — a contact that is
 * neither private nor a colleague, and one people do have on the days they
 * most want to look back at.
 */
export const CONTACT_CIRCLE_KEYS = [
  "partner",
  "child",
  "family",
  "friends",
  "colleagues",
  "acquaintances",
  "professional",
  "other",
] as const;

/** How the contact happened. */
export const CONTACT_FORM_KEYS = [
  "inPerson",
  "phone",
  "video",
  "written",
] as const;

/** Roughly how long it lasted, in the coarse bands people actually recall. */
export const CONTACT_EXTENT_KEYS = ["brief", "medium", "extended"] as const;

/** What the free time was spent on. Multi-select. */
export const LEISURE_CATEGORY_KEYS = [
  "film",
  "reading",
  "gaming",
  "music",
  "creative",
  "outing",
  "garden",
  "cooking",
  "timeWithChild",
  "relaxation",
  "other",
] as const;

/**
 * The kind of thing that happened. One per entry: a day with two notable
 * events is a day with two things worth writing in the note, and a list here
 * would invite ticking every box rather than naming the one that mattered.
 */
export const EVENT_TYPE_KEYS = [
  "goodNews",
  "badNews",
  "success",
  "disappointment",
  "conflict",
  "appointment",
  "familyEvent",
  "change",
  "unexpected",
] as const;

/**
 * Every 0-10 self-rating on the context row, in capture order.
 *
 * Each one has a low and a high anchor in the locale bundles
 * (`mood.context.rating.<field>.{low,high}`), because a bare number on a
 * ten-point scale means whatever the person reading it decides it means, and
 * an anchor is what makes the value they set last week comparable to the one
 * they set today. `workLoad` is inverse-oriented — higher is heavier, not
 * better — and it is stored exactly as the person set it against the anchors
 * they read. A surface that needs "up is better" flips the sign itself, the
 * same rule `MoodEntry.stressA2` follows.
 */
export const CONTEXT_RATING_FIELDS = [
  "workLoad",
  "workSatisfaction",
  "contactQuality",
  "contactSupport",
  "leisureJoy",
  "leisureRecovery",
] as const;

/** The four sections, in capture order. */
export const CONTEXT_SECTION_KEYS = [
  "work",
  "contacts",
  "leisure",
  "events",
] as const;
export type ContextSection = (typeof CONTEXT_SECTION_KEYS)[number];

/**
 * i18n key for one vocabulary value.
 *
 * Resolved from data rather than written at a call site, which is why
 * `mood.context` sits in the reverse-coverage guard's dynamic allowlist beside
 * `mood.dimension` and `mood.tag`.
 */
export function contextValueLabelKey(
  field: string,
  value: string,
): `mood.context.${string}.${string}` {
  return `mood.context.${field}.${value}`;
}

/** i18n key for a section heading. */
export function contextSectionLabelKey(
  section: ContextSection,
): `mood.context.section.${ContextSection}` {
  return `mood.context.section.${section}`;
}

/**
 * The multi-select lists as they are stored: a JSON array in a string column,
 * matching `MoodEntry.tags`.
 *
 * Encoding lives here rather than at the three call sites that need it,
 * because a column read by a route, a backup and an analysis is exactly the
 * kind of thing that ends up with three parsers and two of them wrong.
 */
export function encodeKeyList(keys: readonly string[] | null): string | null {
  if (!keys || keys.length === 0) return null;
  return JSON.stringify([...keys]);
}

/** Decode a stored key list. A malformed value reads as empty, never throws. */
export function decodeKeyList(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}
