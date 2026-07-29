/**
 * Resolve a workout detail deep-link to the canonical row selected by the API.
 *
 * The API owns duplicate clustering and source priority. The client must only
 * follow its bounded identifier; it must never try to reimplement matching or
 * source selection from workout data.
 */
export function canonicalWorkoutDetailHref(
  requestedId: string,
  canonicalId: unknown,
): string | null {
  if (typeof canonicalId !== "string") return null;
  const normalized = canonicalId.trim();
  if (normalized.length === 0 || normalized === requestedId) return null;
  return `/insights/workouts/${encodeURIComponent(normalized)}`;
}
