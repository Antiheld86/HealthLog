/**
 * Naming the profile fields a save declined.
 *
 * `applyProfileUpdate` (`src/lib/auth/profile-update.ts`) writes every
 * field that validated and reports the rest back: `data.rejectedFields`
 * on a partial success, `details.issues` when nothing could be written
 * at all. Both carry the schema key (`heightCm`, `gender`, ...) and a
 * machine-readable code — never a sentence a person should read.
 *
 * Turning that key into words is the client's job, and every screen
 * that writes the profile has to do it the same way, or the same
 * rejection reads differently depending on where the person happened
 * to be standing. This module is that one way: the settings account
 * form and the onboarding baseline step both resolve the key through
 * it, each passing the labels its own inputs already carry.
 */

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
 * shown next to that input on the settings account form. The server
 * only ever knows the field by its schema key — naming it in a
 * person-facing sentence is the client's job, using labels that already
 * exist and are already localized for that form.
 *
 * A screen with different labels for the same fields (the onboarding
 * baseline step calls them by its own names) passes its own map to
 * `describeRejectedProfileField` instead.
 */
export const PROFILE_FIELD_LABEL_KEYS: Record<string, string> = {
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
 * schema key for a field the calling screen has no input for
 * (defensive — every field a form submits is expected in its map).
 */
export function describeRejectedProfileField(
  fields: RejectedProfileField[] | undefined,
  t: (key: string) => string,
  labelKeys: Record<string, string> = PROFILE_FIELD_LABEL_KEYS,
): string | null {
  const first = fields?.[0];
  if (!first) return null;
  const labelKey = labelKeys[first.path];
  return labelKey ? t(labelKey) : first.path;
}
