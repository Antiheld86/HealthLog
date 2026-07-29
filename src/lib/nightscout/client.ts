/**
 * Nightscout CGM client (v1.17.0).
 *
 * Nightscout is a per-user SELF-HOSTED continuous-glucose hub: the self-hoster
 * runs their own instance (Railway / Heroku / Fly / a LAN box) and HealthLog
 * is the CLIENT pulling SGV (sensor glucose value) entries off it. This module
 * is the single source of truth for the wire shape, auth, the SGV parse, and
 * the entry→Measurement mapping. No SDK — hand-rolled fetch over `safeFetch`,
 * mirroring the Withings / WHOOP / Fitbit clients.
 *
 * SSRF (critical): every outbound call re-evaluates the exact server-owned
 * origin policy. Public instances use safeFetch's input and DNS-pinned public
 * verdict. A private origin is reachable only when its complete canonical
 * scheme/host/port is in NIGHTSCOUT_PRIVATE_ORIGINS. The legacy user boolean
 * is accepted as compatibility input but never grants egress.
 *
 * Auth: Nightscout accepts the API secret two ways — the `api-secret` HTTP
 * header carrying the SHA1 hex of the secret, OR a `token` query param (a
 * role-scoped access token). The stored field can hold either; default to the
 * token query param (works for both role tokens and a raw secret on modern
 * instances) and offer the SHA1 header mode for classic `API_SECRET` setups.
 */
import { createHash } from "node:crypto";

import type { MeasurementType } from "@/generated/prisma/client";
import { safeFetch } from "@/lib/safe-fetch";
import {
  configuredNightscoutPrivateOrigins,
  evaluateNightscoutOrigin,
  NIGHTSCOUT_PRIVATE_ORIGIN_REASON,
} from "@/lib/validations/nightscout";
import { SafeFetchError } from "@/lib/safe-fetch";

/** Default per-request timeout for a Nightscout fetch. */
const NIGHTSCOUT_TIMEOUT_MS = 15_000;

/** Canonical glucose storage unit. Nightscout SGV is always mg/dL on the wire. */
export const NIGHTSCOUT_GLUCOSE_UNIT = "mg/dL" as const;

/** How auth is presented to the instance. */
export type NightscoutAuthMode = "token" | "header";

/**
 * One raw SGV entry as Nightscout's `/api/v1/entries.json` returns it. Only
 * the fields we read are typed; the upstream payload carries many more
 * (`direction`, `noise`, `device`, …) that we deliberately ignore.
 */
export interface NightscoutSgvEntry {
  _id?: string;
  type?: string;
  /** Sensor glucose value in mg/dL. */
  sgv?: number | null;
  /** Epoch milliseconds of the reading. */
  date?: number | null;
  dateString?: string;
}

/** A parsed, validated SGV entry (numeric value + millisecond timestamp). */
export interface ParsedSgvEntry {
  id: string | null;
  sgv: number;
  date: number;
}

/** The mapped, source-tagged measurement a sync writes for one SGV entry. */
export interface NightscoutMeasurement {
  type: MeasurementType;
  value: number;
  unit: typeof NIGHTSCOUT_GLUCOSE_UNIT;
  measuredAt: Date;
  externalId: string;
}

export interface FetchSgvOptions {
  baseUrl: string;
  token: string;
  count: number;
  /** @deprecated Compatibility metadata only; never egress authority. */
  allowPrivateHost?: boolean;
  /** Defaults to `token` (query param). `header` uses the api-secret SHA1. */
  authMode?: NightscoutAuthMode;
  /** Override the default timeout (tests). */
  timeoutMs?: number;
}

/** SHA1 hex of a string — the `api-secret` header format Nightscout expects. */
export function sha1Hex(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex");
}

/**
 * Strip a trailing slash so URL concatenation never produces `com//api`.
 */
function normaliseBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Build the `/api/v1/entries.json` URL for `count` SGV entries. Pins
 * `type=sgv` upstream so non-glucose rows (meter BG, calibration) never reach
 * the client; the parse re-checks anyway. When `token` is supplied it is
 * appended as the `token` query param (the modern Nightscout auth path).
 */
export function buildEntriesUrl(
  baseUrl: string,
  count: number,
  token?: string,
): string {
  const url = new URL(`${normaliseBase(baseUrl)}/api/v1/entries.json`);
  url.searchParams.set("count", String(count));
  url.searchParams.set("type", "sgv");
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

/**
 * Keep only well-formed SGV rows: `type === "sgv"` (or untyped legacy rows
 * carrying an `sgv`), a finite numeric value, and a millisecond `date`. Drops
 * meter-BG (`mbg`) and calibration (`cal`) rows, and any row missing a value
 * or timestamp. Returns `[]` for a non-array payload (a Nightscout error
 * object, an HTML login page, …) so a misconfigured instance can't crash the
 * sync.
 */
export function parseSgvEntries(payload: unknown): ParsedSgvEntry[] {
  if (!Array.isArray(payload)) return [];
  const out: ParsedSgvEntry[] = [];
  for (const raw of payload as NightscoutSgvEntry[]) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.type && raw.type !== "sgv") continue;
    const sgv = raw.sgv;
    const date = raw.date;
    if (typeof sgv !== "number" || !Number.isFinite(sgv)) continue;
    if (typeof date !== "number" || !Number.isFinite(date)) continue;
    out.push({
      id: typeof raw._id === "string" ? raw._id : null,
      sgv,
      date,
    });
  }
  return out;
}

/** Externalid for a parsed entry — the canonical idempotency key. */
export function externalIdFor(entry: ParsedSgvEntry): string {
  return entry.id ? `ns:${entry.id}` : `ns:date:${entry.date}`;
}

/**
 * Map one parsed SGV entry to a `BLOOD_GLUCOSE` mg/dL measurement. The
 * `externalId` is `ns:<_id>` when the entry carries Nightscout's `_id`, falling
 * back to `ns:date:<epochMs>` (via `externalIdFor`) — both stable per reading,
 * so a re-sync collapses onto the existing row via the
 * `(userId, type, source, externalId)` unique. mg/dL is stored canonical
 * (Nightscout always reports mg/dL; the display unit is a user preference
 * resolved elsewhere). This is the SINGLE entry→measurement mapping — the sync
 * write path consumes it, so the shape can never drift between two copies.
 */
export function mapSgvEntryToMeasurement(
  entry: ParsedSgvEntry,
): NightscoutMeasurement {
  return {
    type: "BLOOD_GLUCOSE",
    value: entry.sgv,
    unit: NIGHTSCOUT_GLUCOSE_UNIT,
    measuredAt: new Date(entry.date),
    externalId: externalIdFor(entry),
  };
}

/**
 * Raised when an instance answers non-2xx or is unreachable. The connect
 * route + sync classifier switch on `status` to tell "wrong token" (401/403)
 * from "instance down" (network) and surface a clear message to the user.
 */
export class NightscoutApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "NightscoutApiError";
    this.status = status;
  }
}

export class NightscoutPolicyError extends Error {
  readonly reasonCode = NIGHTSCOUT_PRIVATE_ORIGIN_REASON;

  constructor() {
    super(NIGHTSCOUT_PRIVATE_ORIGIN_REASON);
    this.name = "NightscoutPolicyError";
  }
}

/**
 * Fetch the most recent `count` SGV entries from the user's instance.
 *
 * SSRF floor: `requirePublicHost` is `true` unless the user opted a private
 * host in via `allowPrivateHost`. Redirects pinned to manual + a timeout
 * always composed. Throws `NightscoutApiError` on a non-2xx response; re-raises
 * a `SafeFetchError` (private host / timeout / network) unchanged so the caller
 * can classify it.
 */
export async function fetchSgvEntries(
  opts: FetchSgvOptions,
): Promise<ParsedSgvEntry[]> {
  const policy = evaluateNightscoutOrigin(
    opts.baseUrl,
    configuredNightscoutPrivateOrigins(),
  );
  if (!policy.allowed || !policy.canonicalOrigin) {
    throw new NightscoutPolicyError();
  }

  const authMode: NightscoutAuthMode = opts.authMode ?? "token";
  const headers: Record<string, string> = { Accept: "application/json" };
  let url: string;

  if (authMode === "header" && opts.token) {
    // Classic `API_SECRET` instances: the SHA1 hex in the api-secret header.
    headers["api-secret"] = sha1Hex(opts.token);
    url = buildEntriesUrl(policy.canonicalOrigin, opts.count);
  } else {
    // Token query-param path (role-scoped access token; the default).
    url = buildEntriesUrl(
      policy.canonicalOrigin,
      opts.count,
      opts.token || undefined,
    );
  }

  let res: Response;
  try {
    res = await safeFetch(
      url,
      { method: "GET", headers },
      {
        // Public origins receive the full literal + DNS-pinned classifier.
        // An exact operator origin may resolve privately; redirects remain
        // manual, so no response can move the request outside that grant.
        requirePublicHost: !policy.privateOriginApproved,
        timeoutMs: opts.timeoutMs ?? NIGHTSCOUT_TIMEOUT_MS,
      },
    );
  } catch (error) {
    if (error instanceof SafeFetchError && error.kind === "private_host") {
      throw new NightscoutPolicyError();
    }
    throw error;
  }

  if (res.status < 200 || res.status >= 300) {
    throw new NightscoutApiError(
      `Nightscout responded ${res.status}`,
      res.status,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new NightscoutApiError("Nightscout returned a non-JSON body", null);
  }

  return parseSgvEntries(body);
}
