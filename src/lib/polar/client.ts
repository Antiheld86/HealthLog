/**
 * v1.17.0 (F4) — Polar AccessLink v3 client for OAuth + data fetching.
 * Docs: https://www.polar.com/accesslink-api/ (re-verify at build).
 * Envelope shapes + windows below verified against the live AccessLink swagger
 * (`accesslink-api/swagger.yaml`) on 2026-07-24; a body that no longer matches
 * emits a `polar.envelope.drift` breadcrumb rather than silently reading empty.
 *
 * Mirrors the WHOOP client structure (`src/lib/whoop/client.ts`): hand-rolled
 * fetch over `safeFetch` (no SDK), an OAuth handshake, typed collection
 * fetchers, and per-resource field→Measurement mappers (self-documenting; there
 * is no separate reference constant).
 *
 * Polar specifics that differ from WHOOP:
 *   - The token endpoint uses HTTP Basic auth (`base64(client_id:client_secret)`)
 *     rather than client_id/secret in the body.
 *   - Polar access tokens DO NOT expire and there is NO refresh token. The
 *     `User.polarRefreshTokenEncrypted` column stays null; `getValidToken`
 *     never refreshes. A revoked grant surfaces as a 401 on the next data read.
 *   - The token response carries `x_user_id` — Polar's numeric member id. It
 *     remains necessary for user registration and direct user-information
 *     lookups, while collection reads identify the user from the access token.
 *   - The client must register the user once (`POST /v3/users`) before data
 *     reads work; a 409 from registration means "already registered" and is
 *     treated as success.
 */
import { annotate, getEvent } from "@/lib/logging/context";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";
import { safeFetch } from "@/lib/safe-fetch";
import { reconstructContiguousSleepTimeline } from "@/lib/sleep/reconstruct-timeline";
import type { Prisma } from "@/generated/prisma/client";
import type { WorkoutSportType } from "@/lib/validations/workout";
import { PolarApiError, classifyPolarResponse } from "./response-classifier";
import { mapPolarSportType } from "./sport-map";

const POLAR_API_BASE = "https://www.polaraccesslink.com";
const POLAR_OAUTH_AUTH_URL = "https://flow.polar.com/oauth2/authorization";
const POLAR_OAUTH_TOKEN_URL = "https://polarremote.com/v2/oauth2/token";

export interface PolarCredentials {
  clientId: string;
  clientSecret: string;
}

/** Resolve the env-configured shared OAuth credentials. This is the fallback
 * the per-user BYO-key resolver (`getPolarClientCredentials`) drops to when a
 * user has not stored their own AccessLink app id/secret. Returns null when
 * unconfigured so the connect route can surface a clean "integration disabled"
 * message. */
export function getPolarCredentials(): PolarCredentials | null {
  const clientId = process.env.POLAR_CLIENT_ID;
  const clientSecret = process.env.POLAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function getPolarRedirectUri(): string {
  // `||`, not `??`: the compose whitelist materialises an unset var as an empty
  // string, which must still fall through to the derived URI.
  return (
    process.env.POLAR_REDIRECT_URI ||
    `${process.env.NEXT_PUBLIC_APP_URL}/api/polar/callback`
  );
}

/**
 * Polar OAuth scope. `accesslink.read_all` grants every read collection so the
 * user consents once. Space-separated on the wire.
 */
export const POLAR_OAUTH_SCOPE = "accesslink.read_all" as const;

/** Build the browser-redirect authorization URL. `state` is the signed nonce. */
export function getAuthorizationUrl(
  state: string,
  creds: PolarCredentials,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: getPolarRedirectUri(),
    scope: POLAR_OAUTH_SCOPE,
    state,
  });
  return `${POLAR_OAUTH_AUTH_URL}?${params}`;
}

export interface PolarTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  x_user_id: number;
}

function basicAuthHeader(creds: PolarCredentials): string {
  const raw = `${creds.clientId}:${creds.clientSecret}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

/** Exchange an authorization code for the access token + `x_user_id`. */
export async function exchangeCode(
  code: string,
  creds: PolarCredentials,
): Promise<PolarTokenResponse> {
  const start = performance.now();
  const res = await safeFetch(POLAR_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(creds),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: getPolarRedirectUri(),
    }).toString(),
  });
  const json = await res.json().catch(() => null);
  const verdict = classifyPolarResponse(res.status);
  getEvent()?.addExternalCall({
    service: "polar",
    method: "exchangeCode",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new PolarApiError({
      verb: "exchangeCode",
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
      upstreamError: typeof json?.error === "string" ? json.error : undefined,
    });
  }
  // A 2xx with an empty or non-JSON body (captive portal, gateway 200, 204)
  // leaves `json` null. Casting it straight to the token type handed callers a
  // null they then dereferenced, surfacing an unclassified TypeError instead of
  // a handled integration error. Narrow explicitly and classify as transient.
  if (json === null || typeof json !== "object") {
    throw new PolarApiError({
      verb: "exchangeCode",
      classification: "transient",
      httpStatus: res.status,
      reason: "empty_token_body",
    });
  }
  return json as PolarTokenResponse;
}

/**
 * Register the user with the Polar app (`POST /v3/users`). Required once before
 * any data read works. A 409 means the member is already registered for this
 * app — treated as success. Other non-2xx throw a classified error.
 */
export async function registerUser(
  accessToken: string,
  memberId: string,
): Promise<void> {
  const start = performance.now();
  const res = await safeFetch(`${POLAR_API_BASE}/v3/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ "member-id": memberId }),
  });
  const verdict = classifyPolarResponse(res.status);
  getEvent()?.addExternalCall({
    service: "polar",
    method: "registerUser",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error:
      res.status === 409 || verdict.classification === "success"
        ? undefined
        : verdict.reason,
  });
  // 409 Conflict — member already registered for this app. Idempotent success.
  if (res.status === 409) return;
  if (verdict.classification !== "success") {
    throw new PolarApiError({
      verb: "registerUser",
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
    });
  }
}

// ─── Collection reads ──────────────────────────────────────────

/** One Polar Nightly Recharge record. */
export interface PolarNightlyRecharge {
  date: string;
  nightly_recharge_status?: number | null;
  ans_charge?: number | null;
  ans_charge_status?: number | null;
  heart_rate_avg?: number | null;
  heart_rate_variability_avg?: number | null;
  breathing_rate_avg?: number | null;
}

/** One Polar Sleep record. Durations are seconds. */
export interface PolarSleep {
  date: string;
  sleep_start_time?: string;
  sleep_end_time?: string;
  light_sleep?: number | null;
  deep_sleep?: number | null;
  rem_sleep?: number | null;
  total_interruption_duration?: number | null;
  sleep_charge?: number | null;
  sleep_score?: number | null;
  heart_rate_samples?: Record<string, number>;
}

/** One current AccessLink daily-activity summary. */
export interface PolarActivity {
  start_time?: string;
  active_calories?: number | null;
  steps?: number | null;
  calories?: number | null;
  /** Estimated walking/running distance derived from steps, in METRES. */
  distance_from_steps?: number | null;
}

/**
 * One Polar Training Load Pro record (cardio-load collection). `cardio_load` is
 * the session/day cardiovascular load figure — Polar's WHOOP-day-strain
 * analogue. `strain` / `tolerance` / `cardio_load_ratio` describe the
 * acute-vs-chronic balance; only `cardio_load` is mapped today (the others are
 * derived ratios we don't surface yet).
 */
export interface PolarCardioLoad {
  date: string;
  cardio_load?: number | null;
  strain?: number | null;
  tolerance?: number | null;
  cardio_load_ratio?: number | null;
}

/** One Polar SpO2 (Elixir pulse-ox) test result. `test_time` is a Unix
 * timestamp in seconds; `blood_oxygen_percent` is the recorded percentage. */
export interface PolarSpo2 {
  source_device_id?: string;
  test_time?: number;
  blood_oxygen_percent?: number | null;
}

interface CollectionResult<T> {
  records: T[];
}

/** Top-level key NAMES of a drifted response envelope, capped at 10. NAMES
 *  only, never values — no health data can ride the drift annotation. */
function topLevelKeys(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>).slice(0, 10);
}

/** Emit the fixed-shape envelope-drift breadcrumb, then let the caller degrade
 *  to `[]`. Pinned `{verb, httpStatus, keys}` shape so the wide-event dashboard
 *  stays stable; a Polar-side envelope rename shows up here instead of silently
 *  reading as "no data". */
function annotateEnvelopeDrift(
  verb: string,
  httpStatus: number,
  body: unknown,
): void {
  annotate({
    action: {
      name: "polar.envelope.drift",
      details: { verb, httpStatus, keys: topLevelKeys(body) },
    },
  });
}

async function fetchCollection<T>(
  path: string,
  accessToken: string,
  verb: string,
  recordsKey?: string,
): Promise<T[]> {
  const start = performance.now();
  const res = await safeFetch(`${POLAR_API_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const verdict = classifyPolarResponse(res.status);
  getEvent()?.addExternalCall({
    service: "polar",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new PolarApiError({
      verb,
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
    });
  }
  // 204 No Content — a window with no records. Polar returns an empty body.
  if (res.status === 204) return [];
  const json = (await res.json().catch(() => null)) as
    CollectionResult<T> | Record<string, T[]> | T[] | null;
  // A 200 with a null/unparseable body where the contract documents 204 for an
  // empty window: log the drift, then degrade to [] (behavior unchanged).
  if (json === null) {
    annotateEnvelopeDrift(verb, res.status, null);
    return [];
  }
  if (Array.isArray(json)) return json;
  if (!recordsKey) {
    // A bare array is the verified shape for this endpoint (activities /
    // cardio-load / spo2) but the body is a non-array object — an envelope
    // rename would read as "no data". Log, then degrade.
    annotateEnvelopeDrift(verb, res.status, json);
    return [];
  }
  const list = (json as Record<string, unknown>)[recordsKey];
  if (Array.isArray(list)) return list as T[];
  // The expected records key (`recharges` / `nights`) is missing or not an
  // array — the same silent-"no data" drift class. Log, then degrade.
  annotateEnvelopeDrift(verb, res.status, json);
  return [];
}

/** Nightly Recharge collection. Verified envelope: wrapped `{recharges: [...]}`.
 *  Window: the last 28 days, server-fixed (no request params, no pagination). */
export function fetchNightlyRecharges(
  accessToken: string,
): Promise<PolarNightlyRecharge[]> {
  return fetchCollection<PolarNightlyRecharge>(
    "/v3/users/nightly-recharge",
    accessToken,
    "fetchNightlyRecharges",
    "recharges",
  );
}

/** Sleep collection. Verified envelope: wrapped `{nights: [...]}`. Window: the
 *  last 28 days, server-fixed (no request params, no pagination). */
export function fetchSleeps(accessToken: string): Promise<PolarSleep[]> {
  return fetchCollection<PolarSleep>(
    "/v3/users/sleep",
    accessToken,
    "fetchSleeps",
    "nights",
  );
}

/** Daily-activity collection. Verified envelope: a BARE array (no wrapper key).
 *  Window: defaults to the last 28 days; optional `from`/`to` (max 28-day range,
 *  `from` ≤ 365 days back) are deliberately not sent — the default equals the
 *  in-window maximum, so pinning them buys no coverage and adds a request-surface
 *  failure mode. No pagination. */
export function fetchActivities(accessToken: string): Promise<PolarActivity[]> {
  return fetchCollection<PolarActivity>(
    "/v3/users/activities",
    accessToken,
    "fetchActivities",
  );
}

/** Training Load Pro collection — `cardio_load` strain figures. Verified
 *  envelope: a BARE array (no wrapper key). Window: the last 28 days on the bare
 *  list (ranged `/date` and `/period/days/{1..180}` variants exist for deeper
 *  history but are backfill machinery, not sent here). No pagination. */
export function fetchCardioLoads(
  accessToken: string,
): Promise<PolarCardioLoad[]> {
  return fetchCollection<PolarCardioLoad>(
    "/v3/users/cardio-load",
    accessToken,
    "fetchCardioLoads",
  );
}

/** SpO2 (Elixir pulse-ox) collection — nightly blood-oxygen readings. Verified
 *  envelope: a BARE array (no wrapper key). Window: defaults to the last 28 days
 *  (optional `from`/`to`, max 28-day range, not sent). No pagination. */
export function fetchSpo2(accessToken: string): Promise<PolarSpo2[]> {
  return fetchCollection<PolarSpo2>(
    "/v3/users/biosensing/spo2",
    accessToken,
    "fetchSpo2",
  );
}

// ─── Field → Measurement mapping ───────────────────────────────

const SEC_TO_MIN = 1 / 60;

function round2(n: number): number {
  return parseFloat(n.toFixed(2));
}

/** A single mapped reading destined for one `Measurement` row. The sync layer
 * stamps `source = POLAR` + `externalId = <resource>:<date>:<fieldTag>` unless
 * the mapper supplies its own full `externalId` (the per-segment sleep rows
 * need an index in the key). */
export interface MappedMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  fieldTag: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE" | "IN_BED";
  /**
   * Full externalId for rows the mapper keys itself rather than letting the
   * sync layer build `<resource>:<date>:<fieldTag>`. The reconstructed sleep
   * segments (one row per synthetic span) carry an index so the several rows of
   * one stage stay distinct under `userId_type_source_externalId`. When set the
   * sync layer uses it verbatim.
   */
  externalId?: string;
  /**
   * `true` on per-segment sleep rows whose ORDER is synthesised. When Polar
   * gives only per-stage duration totals (no per-stage onset timestamps), the
   * timeline is reconstructed in a fixed physiological order; the UI labels such
   * a night as an approximate layout and never presents it as measured timing.
   */
  reconstructed?: boolean;
}

/** A `nightly_recharge_status` is Polar's 1–6 recovery band; map it to a
 * 0–100 RECOVERY_SCORE so it feeds the canonical recovery ladder below WHOOP.
 * The status is the most stable recovery signal Polar exposes; we linearly
 * rescale 1–6 → 0–100 (1 = worst, 6 = best). */
function rechargeStatusToScore(status: number): number {
  const clamped = Math.max(1, Math.min(6, status));
  return round2(((clamped - 1) / 5) * 100);
}

/**
 * Map one Polar Nightly Recharge record. The recovery band → `RECOVERY_SCORE`
 * (source POLAR, distinct from the COMPUTED proxy); HRV → `HRV_RMSSD`; the
 * nightly average HR → `RESTING_HEART_RATE`; breathing rate → `RESPIRATORY_RATE`.
 * `measuredAt` is the record's date anchored at noon (the wake
 * morning the night belongs to).
 */
export function mapNightlyRecharge(
  r: PolarNightlyRecharge,
): MappedMeasurement[] {
  const measuredAt = canonicalDailyTimestamp(r.date);
  if (Number.isNaN(measuredAt.getTime())) return [];
  const out: MappedMeasurement[] = [];

  if (typeof r.nightly_recharge_status === "number") {
    out.push({
      type: "RECOVERY_SCORE",
      value: rechargeStatusToScore(r.nightly_recharge_status),
      unit: "score",
      measuredAt,
      fieldTag: "recovery",
    });
  }
  if (
    typeof r.heart_rate_variability_avg === "number" &&
    r.heart_rate_variability_avg > 0
  ) {
    out.push({
      type: "HRV_RMSSD",
      value: round2(r.heart_rate_variability_avg),
      unit: "ms",
      measuredAt,
      fieldTag: "hrv_rmssd",
    });
  }
  if (typeof r.heart_rate_avg === "number" && r.heart_rate_avg > 0) {
    out.push({
      type: "RESTING_HEART_RATE",
      value: Math.round(r.heart_rate_avg),
      unit: "bpm",
      measuredAt,
      fieldTag: "rhr",
    });
  }
  if (typeof r.breathing_rate_avg === "number" && r.breathing_rate_avg > 0) {
    out.push({
      type: "RESPIRATORY_RATE",
      value: round2(r.breathing_rate_avg),
      unit: "breaths/min",
      measuredAt,
      fieldTag: "resp_rate",
    });
  }
  // ANS charge — the HRV-based autonomic-nervous-system component of Nightly
  // Recharge, Polar's primary differentiated recovery signal. It is a deviation
  // around the personal baseline (can be negative), so map it through as-is
  // rather than clamping like the 1–6 recovery band. `0` is a valid reading
  // (baseline), so guard on `number` only, not truthiness.
  if (typeof r.ans_charge === "number") {
    out.push({
      type: "ANS_CHARGE",
      value: round2(r.ans_charge),
      unit: "score",
      measuredAt,
      fieldTag: "ans_charge",
    });
  }
  return out;
}

/**
 * Map one Polar Sleep record into per-stage `SLEEP_DURATION` rows + the
 * `SLEEP_SCORE` percentage.
 *
 * `measuredAt` follows the END-instant convention every other sleep integration
 * uses (WHOOP/Withings/Fitbit) and that the canonical night-grouper
 * (`analytics/sleep-night.ts`) depends on: each stage segment is stamped at its
 * own END instant so the hypnogram has an ordered internal timeline and the
 * wake-day key resolves to the right LOCAL day even for negative-UTC users.
 *
 * Polar's sleep collection carries only per-stage DURATION totals plus the
 * night's `sleep_start_time` / `sleep_end_time` (ISO-8601 with local offset) —
 * no per-stage onset timestamps. So we RECONSTRUCT an ordered, contiguous
 * timeline exactly like WHOOP: lay the asleep stages back-to-back from
 * `sleep_start_time` in a fixed physiological order (CORE → DEEP → REM),
 * emitting one timed row per segment ending at the running cursor, and stamp the
 * `IN_BED` envelope + the score row at `sleep_end_time`. The ORDER is synthetic,
 * so every reconstructed segment is flagged `reconstructed: true` and keyed by
 * a stage-tagged externalId so the several rows of one night stay distinct.
 *
 * If the night carries no usable start/end (older records, missing fields) we
 * fall back to a midnight-UTC anchor and emit untimed stage rows — degraded but
 * never wrong-day for the common UTC-positive case, matching the pre-fix shape.
 */
export function mapSleep(s: PolarSleep): MappedMeasurement[] {
  const out: MappedMeasurement[] = [];

  const startMs = s.sleep_start_time ? Date.parse(s.sleep_start_time) : NaN;
  const endMs = s.sleep_end_time ? Date.parse(s.sleep_end_time) : NaN;
  const haveWindow =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;

  const stages: Array<
    [number | null | undefined, "CORE" | "DEEP" | "REM" | "AWAKE", string]
  > = [
    // AWAKE first — Polar reports the night's total interruption time, but no
    // per-stage onset. Lay it as a leading settling-in/awake block so the asleep
    // stages partition the remaining window and the night reader can surface a
    // real awakeMinutes / efficiency rather than reading the night as fully
    // consolidated. Matches WHOOP's leading-AWAKE ordering.
    [s.total_interruption_duration, "AWAKE", "sleep_awake"],
    [s.light_sleep, "CORE", "sleep_core"],
    [s.deep_sleep, "DEEP", "sleep_deep"],
    [s.rem_sleep, "REM", "sleep_rem"],
  ];

  if (haveWindow) {
    // Reconstructed timeline: lay each stage contiguously from onset, one timed
    // row per segment ending at the running cursor. The order is synthetic
    // (Polar gives no per-stage onset), so the shared builder flags every
    // segment reconstructed; the same algorithm backs WHOOP's `mapSleep`.
    out.push(
      ...reconstructContiguousSleepTimeline({
        startMs,
        stages: stages.map(([sec, stage, fieldTag]) => ({
          durationMs:
            typeof sec === "number" && Number.isFinite(sec) ? sec * 1000 : sec,
          stage,
          fieldTag,
        })),
        // IN_BED — single envelope row over the whole sleep window, stamped at
        // the sleep END so the in-bed reader resolves the span back to
        // [start, end].
        inBed: {
          durationMs: endMs - startMs,
          measuredAt: new Date(endMs),
          fieldTag: "sleep_in_bed",
        },
        // Stage-tagged externalId keeps the several segment rows of one night
        // distinct under userId_type_source_externalId (one segment per stage,
        // no positional index — an index renumbered on a re-score when a
        // stage's duration flipped 0↔positive, minting fresh ids that
        // double-counted the night).
        externalIdFor: (fieldTag) => `sleep:${s.date}:seg:${fieldTag}`,
      }),
    );

    if (typeof s.sleep_score === "number") {
      out.push({
        type: "SLEEP_PERFORMANCE",
        value: round2(s.sleep_score),
        unit: "%",
        measuredAt: new Date(endMs),
        fieldTag: "sleep_score",
      });
    }
    return out;
  }

  // Fallback: no usable window. Anchor at noon of the wake date and emit
  // untimed stage rows (the pre-v1.17.1 shape) so a record missing the window
  // fields still contributes a night total.
  const measuredAt = canonicalDailyTimestamp(s.date);
  if (Number.isNaN(measuredAt.getTime())) return [];
  for (const [sec, stage, fieldTag] of stages) {
    if (typeof sec === "number" && sec >= 0) {
      out.push({
        type: "SLEEP_DURATION",
        value: round2(sec * SEC_TO_MIN),
        unit: "minutes",
        measuredAt,
        fieldTag,
        sleepStage: stage,
      });
    }
  }
  if (typeof s.sleep_score === "number") {
    out.push({
      type: "SLEEP_PERFORMANCE",
      value: round2(s.sleep_score),
      unit: "%",
      measuredAt,
      fieldTag: "sleep_score",
    });
  }
  return out;
}

/** Map one current AccessLink daily-activity record: `steps` +
 * `active_calories` where Polar reports them. The active energy portion is
 * used instead of total `calories`, which includes BMR. */
export function mapActivity(a: PolarActivity): MappedMeasurement[] {
  if (typeof a.start_time !== "string") return [];
  const measuredAt = canonicalDailyTimestamp(a.start_time.slice(0, 10));
  if (Number.isNaN(measuredAt.getTime())) return [];
  const out: MappedMeasurement[] = [];
  const steps = a.steps;
  if (typeof steps === "number" && steps >= 0) {
    out.push({
      type: "ACTIVITY_STEPS",
      value: Math.round(steps),
      unit: "steps",
      measuredAt,
      fieldTag: "steps",
    });
  }
  const activeCalories = a.active_calories;
  if (typeof activeCalories === "number" && activeCalories >= 0) {
    out.push({
      type: "ACTIVE_ENERGY_BURNED",
      value: round2(activeCalories),
      unit: "kcal",
      measuredAt,
      fieldTag: "active_energy",
    });
  }
  // Distance derived from steps, already in METRES (canonical SI for
  // WALKING_RUNNING_DISTANCE). Fills the POLAR slot the distance ladder already
  // ranks — previously a phantom entry with no producer.
  const distance = a.distance_from_steps;
  if (typeof distance === "number" && distance >= 0) {
    out.push({
      type: "WALKING_RUNNING_DISTANCE",
      value: round2(distance),
      unit: "meters",
      measuredAt,
      fieldTag: "distance",
    });
  }
  return out;
}

/** Map one Polar Training Load Pro record: `cardio_load` → `CARDIO_LOAD`
 * (Polar's device-native cardiovascular-strain figure). `0` is a valid load, so
 * guard on `number` only. */
export function mapCardioLoad(c: PolarCardioLoad): MappedMeasurement[] {
  const measuredAt = canonicalDailyTimestamp(c.date);
  if (Number.isNaN(measuredAt.getTime())) return [];
  if (typeof c.cardio_load !== "number" || c.cardio_load < 0) return [];
  return [
    {
      type: "CARDIO_LOAD",
      value: round2(c.cardio_load),
      unit: "score",
      measuredAt,
      fieldTag: "cardio_load",
    },
  ];
}

/** Map one Polar SpO2 test result: `blood_oxygen_percent` →
 * `OXYGEN_SATURATION` at the test's exact Unix timestamp. */
export function mapSpo2(r: PolarSpo2): MappedMeasurement[] {
  if (typeof r.test_time !== "number") return [];
  const measuredAt = new Date(r.test_time * 1000);
  if (Number.isNaN(measuredAt.getTime())) return [];
  const pct = r.blood_oxygen_percent;
  if (typeof pct !== "number" || pct <= 0 || pct > 100) return [];
  return [
    {
      type: "OXYGEN_SATURATION",
      value: round2(pct),
      unit: "%",
      measuredAt,
      fieldTag: "spo2",
      externalId: `spo2:${r.test_time}:${r.source_device_id ?? "unknown"}`,
    },
  ];
}

// ─── Exercises (workouts) ──────────────────────────────────────

/**
 * One Polar AccessLink exercise (`GET /v3/exercises`) — the stateless list of
 * the last 30 days of uploads. The transaction model is DEPRECATED; this GET
 * carries NO userId in the path (the user is identified by the Bearer token),
 * exactly the shape the v1.31.2 vitals-endpoint fix established.
 *
 * Field types are conservative on purpose — the live payload's exact per-field
 * nullability and the `id` type are not machine-verified, so `id` accepts
 * string OR number (coerced to a stable string externalId) and every optional
 * numeric is guarded before use.
 */
export interface PolarExercise {
  /** Opaque exercise id. Polar's docs leave the type ambiguous; accept either
   *  and coerce to a stable string externalId (never parsed). */
  id?: string | number | null;
  /** ISO-8601 local start time, e.g. `"2026-06-10T07:00:00"`. May or may not
   *  carry a zone suffix — handled defensively at map time. */
  start_time?: string | null;
  /** Minutes east of UTC for `start_time`. Combined with `start_time` to
   *  recover the true UTC instant. */
  start_time_utc_offset?: number | null;
  /** ISO-8601 duration, e.g. `"PT2H44M30S"`. */
  duration?: string | null;
  /** Coarse sport enum, e.g. `"RUNNING"`. */
  sport?: string | null;
  /** Granular sport enum, e.g. `"TRAIL_RUNNING"`. */
  detailed_sport_info?: string | null;
  calories?: number | null;
  /** Distance in METRES. */
  distance?: number | null;
  heart_rate?: {
    average?: number | null;
    maximum?: number | null;
  } | null;
  training_load?: number | null;
  device?: string | null;
  device_id?: string | null;
}

/**
 * Candidate envelope keys the `/v3/exercises` list might nest under. The
 * verified shape (AccessLink swagger, 2026-07-24) is a BARE array covering the
 * last 30 days OF UPLOADS, with NO pagination token or page parameter — so the
 * bare-array branch is the live path. This tolerant key list is kept purely as
 * defense against a future envelope rename; when it engages (an object body
 * matching none of these keys), the fetch site logs a `polar.envelope.drift`
 * breadcrumb rather than silently reading empty.
 */
const EXERCISE_LIST_KEYS = ["exercises", "data", "items", "records"] as const;

/**
 * Fetch the user's exercises (`GET /v3/exercises`). Summary only — the
 * `samples` / `zones` / `route` inline params are deliberately omitted (route /
 * per-sample import is out of scope). Returns `[]` on 204 No Content, a bare
 * array, or a paged envelope whose list key is unrecognised. Throws a
 * classified `PolarApiError` on a non-2xx — including a 403, which the workout
 * sync classifies as a soft/recoverable integration error so a scope gap on
 * exercises never hard-fails the whole Polar sync.
 */
export async function fetchExercises(
  accessToken: string,
): Promise<PolarExercise[]> {
  const start = performance.now();
  const res = await safeFetch(`${POLAR_API_BASE}/v3/exercises`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const verdict = classifyPolarResponse(res.status);
  getEvent()?.addExternalCall({
    service: "polar",
    method: "fetchExercises",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new PolarApiError({
      verb: "fetchExercises",
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
    });
  }
  // 204 No Content — a window with no uploads. Polar returns an empty body.
  if (res.status === 204) return [];
  const json = (await res.json().catch(() => null)) as unknown;
  // Drift: a non-null object body carrying no recognised list array (none of
  // EXERCISE_LIST_KEYS holds an array) would silently read as "no uploads". Log
  // at the fetch site — `normaliseExerciseList` stays a pure function — then
  // degrade to its []. A correctly-shaped `{exercises: []}` finds an (empty)
  // array under a known key and does NOT drift.
  if (
    json !== null &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    !EXERCISE_LIST_KEYS.some((k) =>
      Array.isArray((json as Record<string, unknown>)[k]),
    )
  ) {
    annotateEnvelopeDrift("fetchExercises", res.status, json);
  }
  return normaliseExerciseList(json);
}

/** Coerce a `/v3/exercises` body into a `PolarExercise[]`: a bare array, a
 *  paged envelope (list under one of `EXERCISE_LIST_KEYS`), or `[]` otherwise. */
export function normaliseExerciseList(json: unknown): PolarExercise[] {
  if (!json) return [];
  if (Array.isArray(json)) return json as PolarExercise[];
  if (typeof json === "object") {
    const obj = json as Record<string, unknown>;
    for (const key of EXERCISE_LIST_KEYS) {
      const list = obj[key];
      if (Array.isArray(list)) return list as PolarExercise[];
    }
  }
  return [];
}

// ─── Exercise → Workout mapping ────────────────────────────────

/** The `Workout`-row payload a mapped Polar exercise produces. Field names
 *  mirror `prisma.workout` columns; the sync layer stamps `source = POLAR` +
 *  `externalId` and upserts on `(userId, source, externalId)`. Mirrors
 *  `StravaWorkoutRow`. */
export interface PolarWorkoutRow {
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

/** True when an ISO-8601 datetime string already carries a zone designator
 *  (`Z` or `±HH:MM` / `±HHMM`). Drives the two branches of start-time
 *  composition. */
function hasZoneDesignator(iso: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso.trim());
}

/**
 * Combine Polar's `start_time` + `start_time_utc_offset` into the true UTC
 * instant.
 *
 * Two cases, because whether `start_time` carries a zone suffix is not verified
 * against the live payload:
 *   - It already has a zone (`…Z` / `…+02:00`): `Date.parse` yields the correct
 *     instant directly; the offset is NOT applied again.
 *   - No zone (a naive local wall-clock, the documented shape): interpret the
 *     wall-clock AS UTC (append `Z`), then subtract the offset minutes (east of
 *     UTC is positive) to recover the true instant. A missing / non-finite
 *     offset falls back to 0 (treat the wall-clock as UTC).
 *
 * Returns null for a missing / unparseable start (the row is skipped, mirroring
 * Strava's NaN-start guard).
 */
export function combinePolarStart(
  startTime: string | null | undefined,
  offsetMinutes: number | null | undefined,
): Date | null {
  if (typeof startTime !== "string" || startTime.trim() === "") return null;
  const trimmed = startTime.trim();
  if (hasZoneDesignator(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  const asUtcMs = Date.parse(`${trimmed}Z`);
  if (Number.isNaN(asUtcMs)) return null;
  const offset =
    typeof offsetMinutes === "number" && Number.isFinite(offsetMinutes)
      ? offsetMinutes
      : 0;
  return new Date(asUtcMs - offset * 60_000);
}

const ISO_DURATION_RE =
  /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

/**
 * Parse an ISO-8601 duration (`PT2H44M30S`, `PT45S`, `P1DT2H`, fractional
 * seconds allowed) to whole seconds. Malformed / empty input → 0, mirroring
 * Strava's `durationSec ?? 0` fallback so a bad duration never produces a
 * negative window. Hand-rolled — no new dependency.
 */
export function parseIsoDuration(raw: string | null | undefined): number {
  if (typeof raw !== "string") return 0;
  const m = ISO_DURATION_RE.exec(raw.trim());
  if (!m) return 0;
  const [, days, hours, minutes, seconds] = m;
  const total =
    (days ? parseFloat(days) * 86_400 : 0) +
    (hours ? parseFloat(hours) * 3_600 : 0) +
    (minutes ? parseFloat(minutes) * 60 : 0) +
    (seconds ? parseFloat(seconds) : 0);
  if (!Number.isFinite(total) || total < 0) return 0;
  return Math.round(total);
}

/**
 * Map one Polar exercise into a `Workout` row. `detailed_sport_info` is
 * preferred over the coarse `sport`, then mapped through `mapPolarSportType()`
 * to a canonical `WorkoutSportType` — the raw Polar labels are never written to
 * `sportType` directly (kept in `metadata` for provenance). `startedAt` is the
 * UTC instant recovered from `start_time` + `start_time_utc_offset`; `endedAt`
 * is `startedAt + durationSec` (Polar exposes no explicit end). `training_load`
 * rides `metadata` tied to this row (the WHOOP per-workout-strain precedent),
 * never a free-floating Measurement that would survive read-time dedup.
 *
 * Returns null for an exercise with no id or no parseable start instant
 * (nothing to store) — the sync layer skips it, never throws per-row.
 */
export function mapExercise(ex: PolarExercise): PolarWorkoutRow | null {
  if (ex.id === null || ex.id === undefined) return null;
  const externalId = String(ex.id);
  if (externalId.trim() === "") return null;

  const startedAt = combinePolarStart(ex.start_time, ex.start_time_utc_offset);
  if (!startedAt) return null;

  const durationSec = parseIsoDuration(ex.duration);
  const endedAt = new Date(startedAt.getTime() + durationSec * 1000);

  const sportType = mapPolarSportType(ex.detailed_sport_info, ex.sport);

  const avgHeartRate = nonNegInt(ex.heart_rate?.average);
  const maxHeartRate = nonNegInt(ex.heart_rate?.maximum);

  const metadata: Prisma.InputJsonValue = {
    // Raw pre-mapping labels, kept for provenance/debugging — never used as the
    // canonical `sportType` (see `mapPolarSportType()`).
    ...(ex.sport ? { polarSport: ex.sport } : {}),
    ...(ex.detailed_sport_info
      ? { polarDetailedSportInfo: ex.detailed_sport_info }
      : {}),
    ...(ex.device ? { polarDevice: ex.device } : {}),
    ...(ex.device_id ? { polarDeviceId: ex.device_id } : {}),
    ...(typeof ex.training_load === "number" &&
    Number.isFinite(ex.training_load)
      ? { trainingLoad: ex.training_load }
      : {}),
    ...(typeof ex.start_time_utc_offset === "number" &&
    Number.isFinite(ex.start_time_utc_offset)
      ? { startTimeUtcOffset: ex.start_time_utc_offset }
      : {}),
  };

  return {
    externalId,
    sportType,
    startedAt,
    endedAt,
    durationSec,
    totalEnergyKcal: nonNegFloat(ex.calories),
    totalDistanceM: nonNegFloat(ex.distance),
    avgHeartRate,
    maxHeartRate,
    // Not on the exercise summary — deriving it would require a GPX fetch
    // (out of scope). Left null.
    elevationM: null,
    metadata,
  };
}
