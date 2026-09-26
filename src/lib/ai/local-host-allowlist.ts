/**
 * Which private hosts an AI base URL may reach, and how the call is dialled.
 *
 * A base URL for the Local provider, the OpenAI-compatible gateway and the
 * operator's admin key is typed by a person, and for the first two that
 * person is any user of the instance. By default only public hosts are
 * reachable. An operator who runs Ollama, LM Studio or a LiteLLM gateway on
 * their own network grants it through the environment, the same exact-origin
 * grammar `NOTIFICATION_PRIVATE_ORIGINS` and `NIGHTSCOUT_PRIVATE_ORIGINS` use
 * (`src/lib/private-origin-policy.ts`):
 *
 *   AI_PRIVATE_ORIGINS="http://ollama.lan:11434,http://10.0.0.5:4000"
 *
 * A grant is one `scheme://host[:port]`. It is never a wildcard, suffix or
 * range. A granted call is dialled through the pinned operator-approved
 * dispatcher with redirects forbidden, so a listed name that resolves to the
 * metadata range, link-local or the unspecified address is dropped at connect
 * time, and a literal in those ranges cannot be granted at all. Nothing in a
 * request or a settings field can confer a grant.
 *
 * `ALLOW_LOCAL_AI_PRIVATE_HOSTS` (v1.18.7) stays readable for the one form that
 * can be made safe: a comma-separated host list (`ollama.lan,10.0.0.5`) still
 * grants those exact hosts, on any port, dialled the same pinned way. Its
 * `=true` form granted every private host on the network to every user and
 * cannot be made safe, so from v1.39.3 it grants nothing; the boot readiness
 * summary and a one-time warning say so and name the replacement.
 */
import { isIP } from "node:net";

import {
  isNeverGrantableHost,
  originOfUrl,
  parsePrivateOrigins,
} from "@/lib/private-origin-policy";

const ORIGINS_ENV = "AI_PRIVATE_ORIGINS";
const LEGACY_ENV = "ALLOW_LOCAL_AI_PRIVATE_HOSTS";

/** The operator-facing sentence for a legacy `=true`. Shared with the boot summary. */
export const LEGACY_ANY_HOST_WARNING =
  `${LEGACY_ENV}=true no longer opens every private host (it let any user ` +
  `reach any service on the operator's network). List the AI endpoint ` +
  `instead: ${ORIGINS_ENV}="http://ollama.lan:11434".`;

interface Grants {
  origins: ReadonlySet<string>;
  legacyHosts: ReadonlySet<string>;
}

let cachedKey: string | null = null;
let cached: Grants = { origins: new Set(), legacyHosts: new Set() };
const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/** True when the legacy variable carries its retired `=true` form. */
export function legacyAnyHostConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[LEGACY_ENV]?.trim().toLowerCase() === "true";
}

function parseLegacyHosts(raw: string | undefined): ReadonlySet<string> {
  const value = raw?.trim() ?? "";
  if (!value || value.toLowerCase() === "false") return new Set();
  if (value.toLowerCase() === "true") {
    warnOnce(LEGACY_ANY_HOST_WARNING);
    return new Set();
  }
  const hosts = new Set<string>();
  for (const entry of value.split(",")) {
    const host = entry.trim().toLowerCase();
    if (!host) continue;
    // A host, not a URL: anything with a scheme, path, port or wildcard is a
    // typo for the origin list, and granting a guess would widen it.
    const bare = host.replace(/^\[|\]$/g, "");
    const isIpv6 = isIP(bare) === 6;
    if (!/^[a-z0-9.\-[\]:]+$/.test(host) || (host.includes(":") && !isIpv6)) {
      warnOnce(
        `${LEGACY_ENV}: ignoring entry "${host.slice(0, 200)}": a host name or address, nothing else; use ${ORIGINS_ENV} for a full origin`,
      );
      continue;
    }
    if (isNeverGrantableHost(host)) {
      warnOnce(
        `${LEGACY_ENV}: ignoring entry "${host}": the unspecified address, link-local and metadata addresses cannot be granted`,
      );
      continue;
    }
    hosts.add(bare);
  }
  return hosts;
}

function grants(): Grants {
  const originsRaw = process.env.AI_PRIVATE_ORIGINS;
  const legacyRaw = process.env.ALLOW_LOCAL_AI_PRIVATE_HOSTS;
  const key = `${originsRaw ?? ""}\u0000${legacyRaw ?? ""}`;
  if (key === cachedKey) return cached;
  cached = {
    origins: parsePrivateOrigins(originsRaw, (entry, reason) => {
      warnOnce(`${ORIGINS_ENV}: ignoring entry "${entry}": ${reason}`);
    }),
    legacyHosts: parseLegacyHosts(legacyRaw),
  };
  cachedKey = key;
  return cached;
}

/**
 * The granted origin for this URL, or null. A URL is granted when its exact
 * origin is listed in `AI_PRIVATE_ORIGINS`, or its host is listed in the
 * legacy host list. A host no grant may name is never granted, whatever the
 * lists say.
 */
export function grantedAiOrigin(url: string): string | null {
  // Parse the grants first, so a malformed entry is reported on the first
  // call that could have used it rather than never.
  const { origins, legacyHosts } = grants();
  const origin = originOfUrl(url);
  if (!origin) return null;
  const hostname = new URL(origin).hostname.toLowerCase();
  // Both lists refuse a never-grantable literal when they are parsed, so
  // neither can hold one; a listed name that resolves into those ranges is
  // dropped by the pinned dispatcher at dial time.
  if (origins.has(origin)) return origin;
  if (legacyHosts.has(hostname.replace(/^\[|\]$/g, ""))) return origin;
  return null;
}

/**
 * True when the operator granted this URL's origin. Answers "may this private
 * host be saved and called?", never "is it public?": callers still accept a
 * public URL without any grant.
 */
export function isLocalAiHostAllowed(url: string): boolean {
  return grantedAiOrigin(url) !== null;
}

/**
 * The `safeFetch` destination policy for an AI call to `url`: the pinned
 * public dispatcher unless the operator granted the origin, and then the
 * pinned operator-approved dispatcher for that one origin. Spread into the
 * `safeFetch` options.
 */
export function aiEgressPolicyFor(
  url: string,
):
  | { requirePublicHost: true }
  | { requirePublicHost: false; operatorApprovedPrivateOrigin: string } {
  const origin = grantedAiOrigin(url);
  return origin === null
    ? { requirePublicHost: true }
    : { requirePublicHost: false, operatorApprovedPrivateOrigin: origin };
}

/** Test helper: forget the parsed grants and the warnings already printed. */
export function _resetAiGrantsForTests(): void {
  cachedKey = null;
  warned.clear();
}
