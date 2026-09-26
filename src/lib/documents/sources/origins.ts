/**
 * `DOCUMENT_SOURCE_ORIGINS` (#1038) — the operator grant that lets the
 * document picker reach a Paperless-ngx or Papra instance.
 *
 *   DOCUMENT_SOURCE_ORIGINS="https://paperless.example.com,http://papra.lan:1221"
 *
 * The grammar is the one every private-origin list shares
 * (`src/lib/private-origin-policy.ts`): exact `scheme://host[:port]` origins,
 * no path, query, credentials, wildcard, CIDR or suffix. A malformed entry is
 * logged once, reduced to scheme and host, and grants nothing; the valid
 * entries beside it keep working.
 *
 * Unlike the notification list, this one is the WHOLE trust decision, not an
 * exception on top of a public-host default. An origin that is not listed is
 * refused even when it is a public address, and with the variable unset the
 * picker does not exist: the routes answer 404 and the client renders no
 * button. A person can only ever point their connection at a system the
 * operator named. Every request to a listed origin still goes through
 * `safeFetch` with the origin pinned, redirects forbidden, and the dial-time
 * floor that refuses link-local, metadata and unspecified addresses even for
 * a listed name.
 *
 * Read directly from `process.env` so the compose-whitelist guard sees it,
 * parsed once per distinct value, and re-read on every use: an operator who
 * removes an origin cuts off the stored connections that name it on their
 * next request.
 */
import {
  parsePrivateOrigins,
  redactGrantEntry,
} from "@/lib/private-origin-policy";

const ENV_NAME = "DOCUMENT_SOURCE_ORIGINS";

let cachedRaw: string | undefined;
let cachedOrigins: ReadonlySet<string> = new Set();

export function configuredDocumentSourceOrigins(): ReadonlySet<string> {
  const raw = process.env.DOCUMENT_SOURCE_ORIGINS;
  if (raw === cachedRaw) return cachedOrigins;
  cachedOrigins = parsePrivateOrigins(raw, (redactedEntry, reason) => {
    console.warn(`${ENV_NAME}: ignoring entry "${redactedEntry}": ${reason}`);
  });
  cachedRaw = raw;
  return cachedOrigins;
}

/** Is the picker switched on for this instance at all? */
export function documentSourcesAvailable(): boolean {
  return configuredDocumentSourceOrigins().size > 0;
}

/** Longest base URL a connection may store. */
export const DOCUMENT_SOURCE_BASE_URL_MAX = 2048;

export type SourceBaseVerdict =
  | { ok: true; origin: string; baseUrl: string }
  | { ok: false; reason: "invalid" | "notAllowed" };

/**
 * Validate a base URL a person typed against the operator's list.
 *
 * The base may carry a path (a Paperless served under `/paperless`); only its
 * origin is compared, and it must be listed exactly. Userinfo, a query and a
 * fragment are refused: none of them belongs in a base address, and each is
 * where a pasted credential would sit. Trailing slashes are trimmed so the
 * client can append `/api/...` without doubling one.
 */
export function evaluateSourceBaseUrl(
  value: string,
  origins: ReadonlySet<string> = configuredDocumentSourceOrigins(),
): SourceBaseVerdict {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "invalid" };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, reason: "invalid" };
  }
  if (!origins.has(url.origin)) return { ok: false, reason: "notAllowed" };
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, origin: url.origin, baseUrl: `${url.origin}${path}` };
}

/** The listed origins as the settings card may show them. */
export function listedDocumentSourceOrigins(): string[] {
  return [...configuredDocumentSourceOrigins()]
    .map((origin) => redactGrantEntry(origin))
    .sort();
}
