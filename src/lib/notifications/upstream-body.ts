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
 * The ways a relay can echo a secret back: literally, JSON-escaped (with and
 * without the `\/` form some serialisers write for a slash, common inside a
 * base64 value), and percent-encoded.
 */
function echoForms(secret: string): string[] {
  const json = JSON.stringify(secret).slice(1, -1);
  return [
    ...new Set([
      secret,
      json,
      json.replaceAll("/", "\\/"),
      encodeURIComponent(secret),
    ]),
  ];
}

/** A value and its decoded form; a malformed escape keeps the raw value. */
function withDecoded(part: string): string[] {
  try {
    const decoded = decodeURIComponent(part.replaceAll("+", " "));
    return decoded === part ? [part] : [part, decoded];
  } catch {
    return [part];
  }
}

/** Path segments this long are credentials in Discord, Slack and n8n URLs. */
const MIN_SECRET_PATH_SEGMENT_LENGTH = 16;

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
  const rawLower = raw.toLowerCase();
  for (const secret of knownSecrets) {
    if (!secret || secret.length < MIN_KNOWN_SECRET_LENGTH) continue;
    for (const form of echoForms(secret)) {
      if (raw.includes(form) || cleaned.includes(form)) return undefined;
    }
    // Percent-encoding is case-insensitive in its hex digits.
    if (rawLower.includes(encodeURIComponent(secret).toLowerCase())) {
      return undefined;
    }
  }

  const characters = Array.from(cleaned);
  if (characters.length <= UPSTREAM_BODY_MAX_CHARS) return cleaned;
  return `${characters.slice(0, UPSTREAM_BODY_MAX_CHARS - 1).join("")}…`;
}

/**
 * The secrets a URL can carry on its own: userinfo, every query value
 * (Gotify's `?token=` form) and every path segment of 16 or more characters
 * (a Discord or Slack webhook token, an n8n webhook id). Each part is decoded
 * on its own, so one malformed escape cannot drop the others.
 */
export function secretsInUrl(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const found: string[] = [];
  if (parsed.username) found.push(...withDecoded(parsed.username));
  if (parsed.password) found.push(...withDecoded(parsed.password));
  for (const pair of parsed.search.replace(/^\?/, "").split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const value = pair.slice(eq + 1);
    if (value) found.push(...withDecoded(value));
  }
  for (const segment of parsed.pathname.split("/")) {
    if (segment.length >= MIN_SECRET_PATH_SEGMENT_LENGTH) {
      found.push(...withDecoded(segment));
    }
  }
  return [...new Set(found)];
}

/** A header value and, for the `<scheme> <token>` form, the token alone. */
export function secretsInHeaderValue(value: string | undefined): string[] {
  if (!value) return [];
  const parts = value.trim().split(/\s+/);
  return parts.length > 1 ? [value, parts[parts.length - 1]] : [value];
}
