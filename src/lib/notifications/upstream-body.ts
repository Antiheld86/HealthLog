import { looksSecretShaped } from "@/lib/secret-shape";

/** What the test card shows at most. */
export const UPSTREAM_BODY_MAX_CHARS = 200;
/** What is read off the wire at most, before anything is cleaned or cut. */
const UPSTREAM_BODY_MAX_READ_BYTES = 4096;
/** A configured value shorter than this is not treated as a secret to hide. */
const MIN_KNOWN_SECRET_LENGTH = 4;

/**
 * C0 and C1 control characters, plus the zero-width and bidirectional
 * formatting marks that could make the rendered text read differently from
 * what the relay sent.
 */
function isControlOrFormatting(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

async function readBounded(res: Response): Promise<string | undefined> {
  const reader = res.body?.getReader?.();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < UPSTREAM_BODY_MAX_READ_BYTES) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      // An oversized error page is abandoned, not drained.
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(Math.min(total, UPSTREAM_BODY_MAX_READ_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
      const room = bytes.length - offset;
      if (room <= 0) break;
      bytes.set(chunk.subarray(0, room), offset);
      offset += Math.min(chunk.byteLength, room);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  if (typeof res.text === "function") return res.text();
  return undefined;
}

/**
 * Read what a relay answered on a non-2xx, in a form safe to hand back to
 * the person who pressed the test button.
 *
 * Bounded twice: at most 4 KB is read off the wire, and at most 200
 * characters survive. Control and formatting characters are removed and
 * whitespace collapsed. The text is refused outright (undefined) when it is
 * empty, unreadable, secret-shaped, or contains one of `knownSecrets` (the
 * header value, the auth token, a query-string token): a relay that echoes
 * the credential it rejected must not have that credential shown on screen.
 *
 * The result is for the test routes. Nothing stores it: the ledger and the
 * channel state keep only the status and the reason code.
 */
export async function readUpstreamBody(
  res: Response,
  knownSecrets: ReadonlyArray<string | undefined>,
): Promise<string | undefined> {
  let raw: string | undefined;
  try {
    raw = await readBounded(res);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;

  const cleaned = Array.from(raw, (ch) =>
    isControlOrFormatting(ch.codePointAt(0) ?? 0) ? " " : ch,
  )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;

  if (looksSecretShaped(raw) || looksSecretShaped(cleaned)) return undefined;
  for (const secret of knownSecrets) {
    if (!secret || secret.length < MIN_KNOWN_SECRET_LENGTH) continue;
    if (raw.includes(secret) || cleaned.includes(secret)) return undefined;
  }

  const characters = Array.from(cleaned);
  if (characters.length <= UPSTREAM_BODY_MAX_CHARS) return cleaned;
  return `${characters.slice(0, UPSTREAM_BODY_MAX_CHARS - 1).join("")}…`;
}

/**
 * The secrets a URL can carry on its own: userinfo and every query value
 * (Gotify's `?token=` form).
 */
export function secretsInUrl(url: string): string[] {
  try {
    const parsed = new URL(url);
    const found = [...parsed.searchParams.values()];
    if (parsed.username) found.push(decodeURIComponent(parsed.username));
    if (parsed.password) found.push(decodeURIComponent(parsed.password));
    return found;
  } catch {
    return [];
  }
}

/** A header value and, for the `<scheme> <token>` form, the token alone. */
export function secretsInHeaderValue(value: string | undefined): string[] {
  if (!value) return [];
  const parts = value.trim().split(/\s+/);
  return parts.length > 1 ? [value, parts[parts.length - 1]] : [value];
}
