import { z } from "zod/v4";
import { isPublicUrl } from "@/lib/validations/notifications";

export const NIGHTSCOUT_PRIVATE_ORIGIN_REASON =
  "private_origin_not_approved" as const;
export const NIGHTSCOUT_INVALID_ORIGIN_REASON = "invalid_origin" as const;

export type NightscoutOriginReason =
  | typeof NIGHTSCOUT_PRIVATE_ORIGIN_REASON
  | typeof NIGHTSCOUT_INVALID_ORIGIN_REASON;

export interface NightscoutOriginVerdict {
  allowed: boolean;
  canonicalOrigin: string | null;
  privateOriginApproved: boolean;
  reasonCode: NightscoutOriginReason | null;
}

/**
 * Parse one exact http(s) origin.
 *
 * Credentials, paths, queries, and fragments are deliberately forbidden: the
 * operator grants a complete canonical scheme/host/port trust unit, never a
 * suffix, wildcard, capability URL, or prefix.
 */
function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    if (!url.hostname || url.hostname.includes("*")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function sharesApprovedPrivateHostname(
  origin: string,
  privateOrigins: ReadonlySet<string>,
): boolean {
  const hostname = new URL(origin).hostname;

  for (const approvedOrigin of privateOrigins) {
    const approvedHostname = new URL(approvedOrigin).hostname;
    if (
      hostname === approvedHostname ||
      hostname.endsWith(`.${approvedHostname}`)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Parse the server-only comma-separated exact-origin allowlist.
 *
 * Invalid non-empty entries fail startup/call-site evaluation loudly rather
 * than being skipped: partial acceptance makes an operator believe a private
 * integration is protected while silently changing which origin is trusted.
 */
export function parseNightscoutPrivateOrigins(
  raw: string | undefined,
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const origin = canonicalOrigin(trimmed);
    if (!origin) {
      throw new Error("Invalid NIGHTSCOUT_PRIVATE_ORIGINS entry");
    }
    origins.add(origin);
  }
  return origins;
}

/**
 * Resolve one user-supplied Nightscout base URL against server policy.
 *
 * Exact operator membership wins before the ordinary public-host verdict so a
 * private DNS name can be trusted without granting its suffix or sibling
 * ports. Public origins remain supported without configuration.
 */
export function evaluateNightscoutOrigin(
  value: string,
  privateOrigins: ReadonlySet<string>,
): NightscoutOriginVerdict {
  const origin = canonicalOrigin(value);
  if (!origin) {
    return {
      allowed: false,
      canonicalOrigin: null,
      privateOriginApproved: false,
      reasonCode: NIGHTSCOUT_INVALID_ORIGIN_REASON,
    };
  }

  if (privateOrigins.has(origin)) {
    return {
      allowed: true,
      canonicalOrigin: origin,
      privateOriginApproved: true,
      reasonCode: null,
    };
  }

  // An exact grant must not accidentally become a hostname suffix grant.
  // Deny related hosts before the generic public-host fallback: private DNS
  // names such as cgm.lan may otherwise look syntactically public here.
  if (sharesApprovedPrivateHostname(origin, privateOrigins)) {
    return {
      allowed: false,
      canonicalOrigin: origin,
      privateOriginApproved: false,
      reasonCode: NIGHTSCOUT_PRIVATE_ORIGIN_REASON,
    };
  }

  if (isPublicUrl(origin)) {
    return {
      allowed: true,
      canonicalOrigin: origin,
      privateOriginApproved: false,
      reasonCode: null,
    };
  }

  return {
    allowed: false,
    canonicalOrigin: origin,
    privateOriginApproved: false,
    reasonCode: NIGHTSCOUT_PRIVATE_ORIGIN_REASON,
  };
}

export function configuredNightscoutPrivateOrigins(): ReadonlySet<string> {
  return parseNightscoutPrivateOrigins(process.env.NIGHTSCOUT_PRIVATE_ORIGINS);
}

/**
 * Per-user Nightscout connection input (v1.17.0). The self-hoster points
 * HealthLog at their own Nightscout instance (Railway / Heroku / Fly / a LAN
 * box) and pastes the instance's API token. Both fields are stored encrypted
 * on `User` (`nightscoutUrlEncrypted` / `nightscoutTokenEncrypted`); the
 * legacy private-host boolean is accepted for compatibility but never grants
 * network authority.
 *
 * The URL is validated to be parseable here. Exact server policy is evaluated
 * by the route and again by the client so the request body cannot confer
 * private-network authority.
 */
export const nightscoutConnectSchema = z.object({
  // Trimmed: a trailing space / newline from a copy button reaches the
  // instance verbatim and produces an opaque DNS failure.
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((value) => {
      try {
        const u = new URL(value);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    }, "Must be a valid http(s) URL"),
  // Nightscout API tokens are opaque strings (a role-scoped access token or
  // the raw `API_SECRET`). Optional: a fully public instance with
  // `AUTH_DEFAULT_ROLES=readable` serves SGV entries without a token.
  token: z.string().trim().max(512).optional().default(""),
  // Deprecated request compatibility only. This value is deliberately
  // ignored by the route and client.
  allowPrivateHost: z.boolean().optional().default(false),
});

export type NightscoutConnectInput = z.infer<typeof nightscoutConnectSchema>;
