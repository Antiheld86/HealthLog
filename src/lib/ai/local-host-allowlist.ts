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
 * `ALLOW_LOCAL_AI_PRIVATE_HOSTS` (v1.18.7) stays readable. A comma-separated
 * host list (`ollama.lan,10.0.0.5`) still grants those exact hosts, on any
 * port, dialled the same pinned way.
 *
 * Its `=true` form used to open every private host to every user of the
 * instance. From v1.39.3 it is deprecated and narrowed for one release cycle
 * rather than removed, so a single-user self-host with Ollama on the LAN keeps
 * working after a patch update: it still grants a private host, but only to
 * the configurations the operator owns (the instance-wide admin provider, and
 * provider settings saved on an admin account), and only through the same
 * pinned dispatcher, so the metadata range, link-local and the unspecified
 * address stay unreachable. A non-admin account's own base URL needs an exact
 * origin in `AI_PRIVATE_ORIGINS`. The boot summary and the admin AI settings
 * page say so and name the origins in use.
 */
import { isIP } from "node:net";

import {
  isNeverGrantableHost,
  originOfUrl,
  parsePrivateOrigins,
} from "@/lib/private-origin-policy";
import { isPublicUrl } from "@/lib/validations/notifications";

const ORIGINS_ENV = "AI_PRIVATE_ORIGINS";
const LEGACY_ENV = "ALLOW_LOCAL_AI_PRIVATE_HOSTS";

/** The operator-facing sentence for a legacy `=true`. Shared with the boot summary. */
export const LEGACY_ANY_HOST_WARNING =
  `${LEGACY_ENV}=true is deprecated, set ${ORIGINS_ENV}=<origin> ` +
  `(for example ${ORIGINS_ENV}="http://ollama.lan:11434"); =true will be ` +
  `removed in a later release. Until then it only covers the admin AI ` +
  `provider and AI settings saved on an admin account.`;

/**
 * Who a base URL belongs to. `operatorTrusted` is true for the instance-wide
 * admin provider and for provider settings saved on an admin account: the
 * configurations the deprecated `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true` still
 * covers. Everything else (any non-admin account's own base URL) is not.
 */
export interface AiUrlOwner {
  operatorTrusted?: boolean;
}

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
  // `true` is handled per call in `grantedAiOrigin` (operator-owned
  // configurations only); it is not a host list.
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
export function grantedAiOrigin(
  url: string,
  owner: AiUrlOwner = {},
): string | null {
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
  // Deprecated `=true`: an operator-owned configuration only, and never a
  // literal no grant may name. A name that resolves into those ranges is
  // dropped by the pinned dispatcher at dial time.
  if (
    owner.operatorTrusted === true &&
    legacyAnyHostConfigured() &&
    !isNeverGrantableHost(hostname)
  ) {
    return origin;
  }
  return null;
}

/**
 * True when the operator granted this URL's origin. Answers "may this private
 * host be saved and called?", never "is it public?": callers still accept a
 * public URL without any grant.
 */
export function isLocalAiHostAllowed(
  url: string,
  owner: AiUrlOwner = {},
): boolean {
  return grantedAiOrigin(url, owner) !== null;
}

/**
 * The `safeFetch` destination policy for an AI call to `url`: the pinned
 * public dispatcher unless the operator granted the origin, and then the
 * pinned operator-approved dispatcher for that one origin. Spread into the
 * `safeFetch` options.
 */
export function aiEgressPolicyFor(
  url: string,
  owner: AiUrlOwner = {},
):
  | { requirePublicHost: true }
  | { requirePublicHost: false; operatorApprovedPrivateOrigin: string } {
  const origin = grantedAiOrigin(url, owner);
  return origin === null
    ? { requirePublicHost: true }
    : { requirePublicHost: false, operatorApprovedPrivateOrigin: origin };
}

/**
 * Host names that only resolve on a local network. `isPublicUrl` judges the
 * text of a name, not where it resolves, so `ollama.lan` reads as public to it
 * while the connect-time pin would refuse it.
 */
const LAN_SUFFIXES = [
  ".lan",
  ".local",
  ".home",
  ".home.arpa",
  ".internal",
  ".intranet",
  ".localdomain",
  ".corp",
];

/**
 * The origin an operator would add to `AI_PRIVATE_ORIGINS` for this saved
 * base URL, or null when it needs none: a hosted endpoint, an address no grant
 * can open, an origin the exact list or the legacy host list already covers,
 * or an unparseable value. Used by the admin AI settings page to name what the
 * deprecated `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true` is currently standing in for.
 */
export function originNeedingAiGrant(url: string): string | null {
  const origin = originOfUrl(url);
  if (!origin) return null;
  const hostname = new URL(origin).hostname.toLowerCase();
  if (isNeverGrantableHost(hostname)) return null;
  const lanName =
    !hostname.includes(".") ||
    LAN_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  if (isPublicUrl(url) && !lanName) return null;
  if (grantedAiOrigin(url) !== null) return null;
  return origin;
}

/** Test helper: forget the parsed grants and the warnings already printed. */
export function _resetAiGrantsForTests(): void {
  cachedKey = null;
  warned.clear();
}
