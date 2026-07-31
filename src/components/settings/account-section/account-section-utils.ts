import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

/**
 * v1.4.37 — silent browser-zone auto-seed for the timezone picker.
 *
 * Until v1.4.37 the picker carried a "Browser-Zeitzone übernehmen" /
 * "Use browser timezone" button so the user could overwrite the
 * Europe/Berlin seed with their detected zone on demand. The button
 * was visually noisy next to the picker on mobile and almost every
 * user wants the browser zone anyway, so the affordance retired and
 * the bootstrap effect seeds the form for them.
 *
 * Rules:
 *
 *   - If the stored value is anything other than the Europe/Berlin
 *     default, respect it. The user explicitly picked it.
 *   - If the stored value is the Europe/Berlin default but the
 *     browser actually IS in Berlin, leave it alone — the picker
 *     stays on Berlin and the next save is a no-op.
 *   - If the stored value is the default AND the browser reports a
 *     non-Berlin zone, pre-fill the picker with the detected zone.
 *     The form's existing submit handler persists the change on the
 *     next save; no toast, no banner, no opt-in.
 *
 * The bootstrap deliberately runs inline during render (the strict
 * `react-hooks/set-state-in-effect` rule outlaws setState in an
 * effect for this hydration shape), so this helper has to stay
 * pure — no DOM access, no `useState`. The detected browser zone is
 * passed in by the caller via `detectBrowserTimezone()`.
 */
export function resolveInitialTimezone(
  storedTimezone: string | null | undefined,
  detectedBrowserTimezone: string,
): string {
  const stored = storedTimezone || DEFAULT_TIMEZONE;
  const shouldAutoSeed =
    stored === DEFAULT_TIMEZONE &&
    detectedBrowserTimezone.length > 0 &&
    detectedBrowserTimezone !== DEFAULT_TIMEZONE;
  return shouldAutoSeed ? detectedBrowserTimezone : stored;
}

/**
 * v1.16.4 — settings status hints store the i18n KEY (+ params), not
 * the translated string: a locale switch re-renders the hint in the
 * new language instead of freezing the old-language snapshot. The
 * `text` variant rides a server string verbatim — reserved for
 * endpoints whose message is already a specific, hand-curated,
 * person-safe sentence (e.g. the timezone endpoint's own IANA
 * validation text). It must never carry a generic validator message;
 * the profile save path resolves `meta.errorCode` into a `key` instead
 * so nothing server-generated reaches this screen untranslated.
 */
export type StatusMessage =
  { key: string; params?: Record<string, string | number> } | { text: string };

export function statusText(
  msg: StatusMessage,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  return "key" in msg ? t(msg.key, msg.params) : msg.text;
}

/** A single rejected-field entry from `applyProfileUpdate`'s wire shape
 * (`details.issues` on failure, `data.rejectedFields` on a partial
 * success) — `path` is the schema field name, never shown verbatim. */
export interface RejectedProfileField {
  path: string;
  code: string;
  message?: string;
}

/**
 * Maps a rejected field's schema `path` to the same i18n label already
 * shown next to that input on this screen. The server only ever knows
 * the field by its schema key (`heightCm`, `gender`, ...) — naming it
 * in a person-facing sentence is the client's job, using labels that
 * already exist and are already localized for this form.
 */
const PROFILE_FIELD_LABEL_KEYS: Record<string, string> = {
  email: "auth.email",
  heightCm: "settings.height",
  dateOfBirth: "settings.dateOfBirth",
  gender: "settings.gender",
  fullName: "settings.identity.fullName",
  insurerName: "settings.identity.insurer",
  insuranceNumber: "settings.identity.insuranceNumber",
};

/**
 * Renders the first rejected field's label, falling back to its raw
 * schema key for a field this screen has no input for (defensive —
 * every field `applyProfileUpdate` accepts from this form is mapped
 * above).
 */
export function describeRejectedProfileField(
  fields: RejectedProfileField[] | undefined,
  t: (key: string) => string,
): string | null {
  const first = fields?.[0];
  if (!first) return null;
  const labelKey = PROFILE_FIELD_LABEL_KEYS[first.path];
  return labelKey ? t(labelKey) : first.path;
}
