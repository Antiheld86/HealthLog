/**
 * v1.28.x — Strava API v3 client for OAuth + activity fetching.
 * Docs: https://developers.strava.com/docs/reference/ (re-verify at build).
 *
 * Mirrors the WHOOP / Polar / Oura client structure: hand-rolled fetch over
 * `safeFetch` (no vendor SDK), an OAuth handshake (`getAuthorizationUrl` /
 * `exchangeCode` / `refreshAccessToken`), typed collection fetchers, and a
 * single field → `Workout` mapper.
 *
 * Strava specifics:
 *   - It is a WORKOUT source only — the API is activity-centric and exposes no
 *     sleep / recovery / body / glucose data. It feeds `Workout` rows and only
 *     `Workout` rows. No training-depth analytics (FTP/TSS/power-curve) are
 *     derived — Strava is just another workout source.
 *   - It ROTATES its refresh token on every refresh, so the sync persists BOTH
 *     rotated tokens (the Oura reactive-refresh + compare-and-set model). There
 *     is no token-expiry column; the sync refreshes reactively on a 401.
 *   - The Activities list (`SummaryActivity`) carries distance / moving_time /
 *     elapsed_time / elevation / HR, but `calories` lives only on the
 *     per-activity `DetailedActivity` (`GET /activities/{id}`).
 *   - Rate limits: 200 requests / 15 min and 2000 / day per app. The sync walks
 *     bounded pages and fetches detail budget-aware.
 */
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import type { Prisma } from "@/generated/prisma/client";
import { StravaApiError, classifyStravaResponse } from "./response-classifier";
import { mapStravaSportType } from "./sport-map";
import type { WorkoutSportType } from "@/lib/validations/workout";

const STRAVA_API_BASE = "https://www.strava.com/api/v3";
const STRAVA_OAUTH_AUTH_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_OAUTH_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_DEAUTHORIZE_URL = "https://www.strava.com/oauth/deauthorize";

export interface StravaCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Env-configured shared OAuth credentials — the FALLBACK app used when a user
 * has not registered their own BYO Strava client id/secret. The per-user
 * resolver `getStravaClientCredentials` (DB-first) is the primary path and
 * calls this only when no per-user pair is stored.
 */
export function getStravaCredentials(): StravaCredentials | null {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function getStravaRedirectUri(): string {
  // An empty or blank value counts as unset: the compose whitelist
  // materialises an unset var as an empty string, which must still fall
  // through to the derived URI.
  return (
    process.env.STRAVA_REDIRECT_URI?.trim() ||
    `${process.env.NEXT_PUBLIC_APP_URL?.trim()}/api/strava/callback`
  );
}

/**
 * Strava OAuth scope. `activity:read_all` reads every activity including those
 * marked "only me" (`activity:read` omits private ones). Comma-separated on the
 * wire per Strava's authorization endpoint.
 */
export const STRAVA_OAUTH_SCOPE = "activity:read_all" as const;

export function getAuthorizationUrl(
  state: string,
  creds: StravaCredentials,
): string {
  const params = new URLSearchParams({
    client_id: creds.clientId,
    response_type: "code",
    redirect_uri: getStravaRedirectUri(),
    approval_prompt: "auto",
    scope: STRAVA_OAUTH_SCOPE,
    state,
  });
  return `${STRAVA_OAUTH_AUTH_URL}?${params}`;
}

/** Strava's `SummaryAthlete` — only the numeric id is retained (the granted
 * account pin + webhook fan-out key). */
export interface StravaAthlete {
  id?: number | null;
}

export interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  token_type?: string;
  athlete?: StravaAthlete | null;
}

async function postToken(
  params: URLSearchParams,
  verb: string,
): Promise<StravaTokenResponse> {
  const start = performance.now();
  const res = await safeFetch(STRAVA_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });
  const json = await res.json().catch(() => null);
  const verdict = classifyStravaResponse(res.status);
  getEvent()?.addExternalCall({
    service: "strava",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new StravaApiError({
      verb,
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
      upstreamError:
        typeof json?.message === "string" ? json.message : undefined,
    });
  }
  return json as StravaTokenResponse;
}

export async function exchangeCode(
  code: string,
  creds: StravaCredentials,
): Promise<StravaTokenResponse> {
  return postToken(
    new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      grant_type: "authorization_code",
    }),
    "exchangeCode",
  );
}

export async function refreshAccessToken(
  refreshToken: string,
  creds: StravaCredentials,
): Promise<StravaTokenResponse> {
  return postToken(
    new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    "refreshAccessToken",
  );
}

/**
 * Best-effort deauthorize at Strava on disconnect. Failure is swallowed by the
 * caller — the local grant is cleared regardless, so a Strava-side outage never
 * strands the user with a card that refuses to disconnect.
 */
export async function deauthorize(accessToken: string): Promise<void> {
  const start = performance.now();
  const res = await safeFetch(STRAVA_DEAUTHORIZE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  getEvent()?.addExternalCall({
    service: "strava",
    method: "deauthorize",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: res.ok ? undefined : `http_${res.status}`,
  });
}

// ─── Activity reads (v3) ───────────────────────────────────────

/** Strava `SummaryActivity` — the list-endpoint shape. Distances are metres,
 * durations seconds, `start_date` a UTC ISO-8601 instant. HR / power fields are
 * present when the activity recorded them; `calories` is NOT (detail only). */
export interface StravaSummaryActivity {
  id: number;
  name?: string | null;
  distance?: number | null;
  moving_time?: number | null;
  elapsed_time?: number | null;
  total_elevation_gain?: number | null;
  type?: string | null;
  sport_type?: string | null;
  start_date?: string | null;
  start_date_local?: string | null;
  average_heartrate?: number | null;
  max_heartrate?: number | null;
  has_heartrate?: boolean | null;
  average_watts?: number | null;
  weighted_average_watts?: number | null;
  device_watts?: boolean | null;
  average_cadence?: number | null;
  trainer?: boolean | null;
  commute?: boolean | null;
  gear_id?: string | null;
}

/** Strava `DetailedActivity` — the per-activity shape. Superset of the summary
 * that additionally carries `calories` (kcal). */
export interface StravaDetailedActivity extends StravaSummaryActivity {
  calories?: number | null;
  description?: string | null;
}

export interface FetchActivitiesQuery {
  /** Epoch SECONDS cursor — return activities started after this instant. */
  after?: number;
  page?: number;
  perPage?: number;
}

async function stravaGet<T>(
  path: string,
  accessToken: string,
  verb: string,
): Promise<T> {
  const start = performance.now();
  const res = await safeFetch(`${STRAVA_API_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const verdict = classifyStravaResponse(res.status);
  getEvent()?.addExternalCall({
    service: "strava",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new StravaApiError({
      verb,
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
    });
  }
  return (await res.json().catch(() => null)) as T;
}

/** One page of the athlete's activities (newest first). */
export async function fetchActivities(
  accessToken: string,
  query: FetchActivitiesQuery = {},
): Promise<StravaSummaryActivity[]> {
  const params = new URLSearchParams();
  if (typeof query.after === "number")
    params.set("after", String(Math.floor(query.after)));
  params.set("page", String(query.page ?? 1));
  params.set("per_page", String(query.perPage ?? 100));
  const json = await stravaGet<StravaSummaryActivity[] | null>(
    `/athlete/activities?${params}`,
    accessToken,
    "fetchActivities",
  );
  return Array.isArray(json) ? json : [];
}

/** One activity's `DetailedActivity` — the only source of `calories`. */
export function fetchActivityById(
  accessToken: string,
  id: number | string,
): Promise<StravaDetailedActivity> {
  return stravaGet<StravaDetailedActivity>(
    `/activities/${encodeURIComponent(String(id))}?include_all_efforts=false`,
    accessToken,
    "fetchActivityById",
  );
}

// ─── Activity → Workout mapping ────────────────────────────────

/** The `Workout`-row payload a mapped Strava activity produces. Field names
 * mirror `prisma.workout` columns; the sync layer stamps `source = STRAVA` +
 * `externalId` and upserts on `(userId, source, externalId)`. */
export interface StravaWorkoutRow {
  externalId: string;
  sportType: WorkoutSportType;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  elevationM: number | null;
  metadata: Prisma.InputJsonValue;
}

function nonNegInt(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function nonNegFloat(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Map one Strava activity into a `Workout` row. `sport_type` is preferred over
 * the legacy `type`, then mapped through `mapStravaSportType()` to a canonical
 * `WorkoutSportType` — the raw Strava label is never written to `sportType`
 * directly (see `src/lib/strava/sport-map.ts` for why). The raw label is kept
 * verbatim in `metadata.stravaType` for provenance/debugging. Duration uses
 * `moving_time` (active duration) with `elapsed_time` kept in `metadata`. HR /
 * calories come from the summary when present, else from the optional
 * `DetailedActivity`.
 *
 * The activity `name` / `description` are the user's own free-text DATA — they
 * are stored in `metadata` only and NEVER interpolated into any prompt as an
 * instruction (the MCP/coach free-text rule). Power / cadence / commute flags
 * ride `metadata` for provenance but are NOT surfaced as training analytics.
 * Returns null for an activity with no id / start instant (nothing to store).
 */
export function mapActivity(
  summary: StravaSummaryActivity,
  detail?: StravaDetailedActivity | null,
): StravaWorkoutRow | null {
  if (typeof summary.id !== "number") return null;
  const startIso = summary.start_date ?? detail?.start_date ?? null;
  if (!startIso) return null;
  const startedAt = new Date(startIso);
  if (Number.isNaN(startedAt.getTime())) return null;

  const elapsedSec = nonNegInt(summary.elapsed_time ?? detail?.elapsed_time);
  const movingSec = nonNegInt(summary.moving_time ?? detail?.moving_time);
  const durationSec = movingSec ?? elapsedSec ?? 0;
  // The clock window is elapsed time (moving time excludes pauses); fall back to
  // moving time when elapsed is absent so `endedAt` is never before `startedAt`.
  const endedAt = new Date(
    startedAt.getTime() + (elapsedSec ?? durationSec) * 1000,
  );

  const avgHeartRate = nonNegInt(
    summary.average_heartrate ?? detail?.average_heartrate,
  );
  const maxHeartRate = nonNegInt(
    summary.max_heartrate ?? detail?.max_heartrate,
  );
  const calories = nonNegFloat(detail?.calories);

  const rawSportType =
    summary.sport_type ?? summary.type ?? detail?.sport_type ?? "Workout";
  const sportType = mapStravaSportType(rawSportType);

  const metadata: Prisma.InputJsonValue = {
    // Activity name/description are user free-text → DATA, never instructions.
    ...(summary.name ? { stravaName: summary.name } : {}),
    ...(detail?.description ? { stravaDescription: detail.description } : {}),
    ...(elapsedSec != null ? { elapsedTimeSec: elapsedSec } : {}),
    // Raw pre-mapping label, kept for provenance/debugging — never used as
    // the canonical `sportType` itself (see `mapStravaSportType()`).
    ...(rawSportType ? { stravaType: rawSportType } : {}),
    ...(typeof summary.average_watts === "number"
      ? { averageWatts: summary.average_watts }
      : {}),
    ...(typeof summary.weighted_average_watts === "number"
      ? { weightedAverageWatts: summary.weighted_average_watts }
      : {}),
    ...(typeof summary.device_watts === "boolean"
      ? { deviceWatts: summary.device_watts }
      : {}),
    ...(typeof summary.average_cadence === "number"
      ? { averageCadence: summary.average_cadence }
      : {}),
    ...(typeof summary.trainer === "boolean"
      ? { trainer: summary.trainer }
      : {}),
    ...(typeof summary.commute === "boolean"
      ? { commute: summary.commute }
      : {}),
    ...(summary.gear_id ? { gearId: summary.gear_id } : {}),
  };

  return {
    externalId: String(summary.id),
    sportType,
    startedAt,
    endedAt,
    durationSec,
    totalEnergyKcal: calories,
    totalDistanceM: nonNegFloat(summary.distance ?? detail?.distance),
    avgHeartRate,
    maxHeartRate,
    elevationM: nonNegFloat(
      summary.total_elevation_gain ?? detail?.total_elevation_gain,
    ),
    metadata,
  };
}

/** True when the summary already carries HR + calories are irrelevant — i.e.
 * the summary alone is enough and a detail fetch can be skipped. Strava never
 * puts `calories` on the summary, so a detail fetch is what fills it; callers
 * use this only to decide whether HR is already covered. */
export function summaryHasHeartRate(a: StravaSummaryActivity): boolean {
  return (
    a.has_heartrate === true ||
    typeof a.average_heartrate === "number" ||
    typeof a.max_heartrate === "number"
  );
}
