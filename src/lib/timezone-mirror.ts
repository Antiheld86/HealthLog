/**
 * Client-side mirror of the per-user display timezone.
 *
 * The server-authoritative value lives on the user row (`users.timezone`,
 * surfaced by `/api/auth/me` and editable via `PUT /api/auth/me/timezone`).
 * The mirror follows the `time-format.ts` / `date-format.ts` pattern exactly:
 * `fetchMe` writes the resolved value into localStorage so that
 *
 *   1. `useFormatters()` can read it through `useSyncExternalStore` without
 *      requiring a QueryClient in the tree, and
 *   2. the legacy helpers in `src/lib/format.ts` (plain functions, no React
 *      context) render the same zone as hook-based call sites.
 *
 * Fallback chain: valid mirrored profile zone → `DEFAULT_TIMEZONE`
 * (Europe/Berlin) inside `makeFormatters`. Deliberately NO browser-timezone
 * rung — every server-rendered artifact (doctor-report PDF, exports,
 * briefing) resolves profile → Berlin, and a browser rung would let the same
 * timestamp render differently on screen vs in the PDF for exactly the
 * accounts whose profile zone is stale.
 *
 * Validity is guarded on BOTH sides: `storeTimezone` refuses to persist a
 * non-IANA value (clears the mirror instead, so a poison `/me` payload can
 * never wedge a broken zone), and `readStoredTimezone` re-validates so a
 * stale mirror written by a pre-validation build reads as absent rather
 * than reaching `Intl.DateTimeFormat` (which would throw `RangeError`).
 *
 * SSR always resolves "" (`window` is undefined) → Berlin fallback; the same
 * caveat as the sibling mirrors applies — call sites render their formatted
 * strings post-fetch, so there is no hydration-mismatch path today.
 */

import { isValidTimezone } from "./tz/format";

const STORAGE_KEY = "healthlog-timezone";
const CHANGE_EVENT = "healthlog:timezone-change";

/**
 * Best-effort read of the mirrored zone. "" on SSR / no mirror / invalid
 * stored value — callers treat "" as "fall back to `DEFAULT_TIMEZONE`"
 * (which `makeFormatters` does on its own for an empty `userTz`).
 */
export function readStoredTimezone(): string {
  if (typeof window === "undefined") return "";
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    return stored && isValidTimezone(stored) ? stored : "";
  } catch {
    return "";
  }
}

/**
 * Persist the mirror and notify same-tab subscribers. Cross-tab updates ride
 * the browser's native `storage` event. An invalid or empty value CLEARS the
 * mirror (fail toward the deterministic Berlin fallback) rather than storing
 * a zone `Intl` would throw on.
 */
export function storeTimezone(value: string): void {
  if (typeof window === "undefined") return;
  const next = value && isValidTimezone(value) ? value : null;
  try {
    const previous = window.localStorage?.getItem(STORAGE_KEY) ?? null;
    if (previous === next) return;
    if (next === null) {
      window.localStorage?.removeItem(STORAGE_KEY);
    } else {
      window.localStorage?.setItem(STORAGE_KEY, next);
    }
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** `useSyncExternalStore`-shaped subscription for the mirror. */
export function subscribeTimezone(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
