/**
 * Where the confirm page may send the browser once the person has confirmed
 * it is them.
 *
 * Only back to the connection consent it came from, never anywhere else: the
 * page takes `next` from the address bar, so any path it accepted would be a
 * same-origin redirect somebody else could point. The consent request carries
 * its own parameters and re-validates all of them when it is loaded again.
 */
export const CONSENT_PATH = "/api/mcp/oauth/authorize";

export function confirmReturnTo(
  next: string | null | undefined,
): string | null {
  if (!next || !next.startsWith(`${CONSENT_PATH}?`)) return null;
  try {
    const base = "http://confirm.invalid";
    const resolved = new URL(next, base);
    if (resolved.origin !== base || resolved.pathname !== CONSENT_PATH) {
      return null;
    }
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return null;
  }
}
