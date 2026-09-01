/**
 * WHOOP API v2 client for OAuth and data fetching.
 * Docs: https://developer.whoop.com (re-verify at build — the space moves).
 *
 * Mirrors the Withings client structure (`src/lib/withings/client.ts`):
 * hand-rolled fetch over `safeFetch` (no SDK), an OAuth handshake
 * (`getAuthorizationUrl` / `exchangeCode` / `refreshAccessToken`), typed
 * collection fetchers with `next_token` pagination, and a single
 * source-of-truth field→Measurement mapping (`WHOOP_FIELD_MAP`, kept in sync
 * with `src/lib/whoop/mapping.md`).
 *
 * v2 only — v1 was removed 2025-10-01. Sleep / workout / recovery ids are
 * UUID strings; cycle id is int64. Token TTL 3600 s; refresh tokens ROTATE
 * (each refresh invalidates the prior access AND refresh token — the sync
 * layer persists BOTH rotated tokens). The `offline` scope is required to
 * receive a refresh token at all.
 */
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import { reconstructContiguousSleepTimeline } from "@/lib/sleep/reconstruct-timeline";
import { WhoopApiError, classifyWhoopResponse } from "./response-classifier";

const WHOOP_API_BASE = "https://api.prod.whoop.com/developer";
const WHOOP_OAUTH_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_OAUTH_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

/** WHOOP collection reads cap `limit` at 25. */
export const WHOOP_PAGE_LIMIT = 25;

export interface WhoopCredentials {
  clientId: string;
  clientSecret: string;
}

export function getWhoopRedirectUri(): string {
  // `||`, not `??`: the compose whitelist materialises the var as an empty
  // string when unset, which must still fall through to the derived URI.
  return (
    process.env.WHOOP_REDIRECT_URI ||
    `${process.env.NEXT_PUBLIC_APP_URL}/api/whoop/callback`
  );
}

/**
 * OAuth scopes HealthLog requests (space-separated on the wire). `offline` is
 * mandatory to receive a refresh token; the rest are read-only collection
 * scopes. Request all so the user grants once and every sync resource is
 * covered.
 */
export const WHOOP_OAUTH_SCOPE =
  "offline read:recovery read:sleep read:workout read:cycles read:profile read:body_measurement" as const;

/**
 * Generate the WHOOP OAuth authorization URL (a browser redirect, not a
 * fetch). `state` is the opaque CSRF nonce minted by `oauth-state.ts`.
 */
export function getAuthorizationUrl(
  state: string,
  creds: WhoopCredentials,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: getWhoopRedirectUri(),
    scope: WHOOP_OAUTH_SCOPE,
    state,
  });
  return `${WHOOP_OAUTH_AUTH_URL}?${params}`;
}

export interface WhoopTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

async function postToken(
  params: URLSearchParams,
  verb: string,
): Promise<WhoopTokenResponse> {
  const start = performance.now();
  const res = await safeFetch(WHOOP_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const json = await res.json().catch(() => null);
  const verdict = classifyWhoopResponse(res.status);
  getEvent()?.addExternalCall({
    service: "whoop",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new WhoopApiError({
      verb,
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
      upstreamError: typeof json?.error === "string" ? json.error : undefined,
    });
  }
  return json as WhoopTokenResponse;
}

/** Exchange an authorization code for the initial token pair. */
export async function exchangeCode(
  code: string,
  creds: WhoopCredentials,
): Promise<WhoopTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: getWhoopRedirectUri(),
    }),
    "exchangeCode",
  );
}

/**
 * Refresh an expired access token. WHOOP rotates the refresh token on every
 * use — the caller MUST persist the returned `refresh_token`, not just the
 * access token. `scope` must include `offline` (re-sent here per the WHOOP
 * spec) for the rotation to return a fresh refresh token.
 */
export async function refreshAccessToken(
  refreshToken: string,
  creds: WhoopCredentials,
): Promise<WhoopTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope: "offline",
    }),
    "refreshAccessToken",
  );
}

// ─── Collection envelopes (v2) ─────────────────────────────────

/** WHOOP paginated collection envelope: `{ records, next_token }`. */
export interface WhoopCollection<T> {
  records: T[];
  next_token?: string | null;
}

/** Recovery record. `score` is null until WHOOP finishes scoring. */
export interface WhoopRecovery {
  cycle_id: number;
  sleep_id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: string;
  score: {
    user_calibrating: boolean;
    recovery_score: number;
    resting_heart_rate: number;
    hrv_rmssd_milli: number;
    spo2_percentage?: number;
    skin_temp_celsius?: number;
  } | null;
}

/** Sleep activity record. */
export interface WhoopSleep {
  id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  nap: boolean;
  score_state: string;
  score: {
    stage_summary: {
      total_in_bed_time_milli: number;
      total_awake_time_milli: number;
      total_light_sleep_time_milli: number;
      total_slow_wave_sleep_time_milli: number;
      total_rem_sleep_time_milli: number;
      // v1.12.8 — per-night sleep disturbance tally. Optional: older / still-
      // scoring records may omit it.
      disturbance_count?: number;
    };
    sleep_needed: {
      baseline_milli: number;
      need_from_sleep_debt_milli: number;
      need_from_recent_strain_milli: number;
      need_from_recent_nap_milli: number;
    };
    respiratory_rate?: number;
    sleep_performance_percentage?: number;
    sleep_consistency_percentage?: number;
    sleep_efficiency_percentage?: number;
  } | null;
}

/** Physiological cycle (day) record. `id` is an int64. */
export interface WhoopCycle {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end?: string | null;
  score_state: string;
  score: {
    strain: number;
    kilojoule: number;
    average_heart_rate: number;
    max_heart_rate: number;
  } | null;
}

/** Workout activity record. */
export interface WhoopWorkout {
  id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  sport_id?: number;
  sport_name?: string;
  score_state: string;
  score: {
    strain: number;
    average_heart_rate: number;
    max_heart_rate: number;
    kilojoule: number;
    percent_recorded: number;
    distance_meter?: number;
    altitude_gain_meter?: number;
    altitude_change_meter?: number;
    zone_durations?: Record<string, number>;
  } | null;
}

/** Body-measurement object (single, not paginated). */
export interface WhoopBodyMeasurement {
  height_meter?: number;
  weight_kilogram?: number;
  max_heart_rate?: number;
}

/** Basic profile object (single, not paginated). */
export interface WhoopProfile {
  user_id: number;
  email?: string;
  first_name?: string;
  last_name?: string;
}

interface CollectionQuery {
  start?: Date;
  end?: Date;
  /** Hard ceiling on pages walked (defence against a runaway cursor). */
  maxPages?: number;
}

async function fetchCollection<T>(
  path: string,
  accessToken: string,
  verb: string,
  query: CollectionQuery = {},
): Promise<T[]> {
  const records: T[] = [];
  let nextToken: string | null | undefined;
  let pageCount = 0;
  const maxPages = query.maxPages ?? 1000;

  do {
    const params = new URLSearchParams({ limit: String(WHOOP_PAGE_LIMIT) });
    if (query.start) params.set("start", query.start.toISOString());
    if (query.end) params.set("end", query.end.toISOString());
    if (nextToken) params.set("nextToken", nextToken);

    const pageStart = performance.now();
    const res = await safeFetch(`${WHOOP_API_BASE}${path}?${params}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const json = (await res
      .json()
      .catch(() => null)) as WhoopCollection<T> | null;
    const verdict = classifyWhoopResponse(res.status);
    getEvent()?.addExternalCall({
      service: "whoop",
      method: `${verb}(page=${pageCount})`,
      duration_ms: Math.round(performance.now() - pageStart),
      status: res.status,
      error: verdict.classification === "success" ? undefined : verdict.reason,
    });
    if (verdict.classification !== "success") {
      throw new WhoopApiError({
        verb,
        classification: verdict.classification,
        httpStatus: verdict.httpStatus,
        reason: verdict.reason,
      });
    }

    for (const r of json?.records ?? []) records.push(r);
    nextToken = json?.next_token ?? null;
    pageCount += 1;
  } while (nextToken && pageCount < maxPages);

  return records;
}

async function fetchSingle<T>(
  path: string,
  accessToken: string,
  verb: string,
): Promise<T> {
  const start = performance.now();
  const res = await safeFetch(`${WHOOP_API_BASE}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json().catch(() => null)) as T | null;
  const verdict = classifyWhoopResponse(res.status);
  getEvent()?.addExternalCall({
    service: "whoop",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new WhoopApiError({
      verb,
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
    });
  }
  return json as T;
}

export function fetchRecoveries(
  accessToken: string,
  query?: CollectionQuery,
): Promise<WhoopRecovery[]> {
  return fetchCollection<WhoopRecovery>(
    "/v2/recovery",
    accessToken,
    "fetchRecoveries",
    query,
  );
}

export function fetchSleeps(
  accessToken: string,
  query?: CollectionQuery,
): Promise<WhoopSleep[]> {
  return fetchCollection<WhoopSleep>(
    "/v2/activity/sleep",
    accessToken,
    "fetchSleeps",
    query,
  );
}

export function fetchCycles(
  accessToken: string,
  query?: CollectionQuery,
): Promise<WhoopCycle[]> {
  return fetchCollection<WhoopCycle>(
    "/v2/cycle",
    accessToken,
    "fetchCycles",
    query,
  );
}

export function fetchWorkouts(
  accessToken: string,
  query?: CollectionQuery,
): Promise<WhoopWorkout[]> {
  return fetchCollection<WhoopWorkout>(
    "/v2/activity/workout",
    accessToken,
    "fetchWorkouts",
    query,
  );
}

// ─── Single-record reads (webhook-driven fetch-by-id) ──────────
// A `*.updated` webhook carries only the resource id, not the data. Re-fetch
// that ONE record by id for a targeted refresh — far cheaper than re-walking
// the whole collection, and it lands the record immediately rather than on the
// next overlap window. WHOOP v2 single-record paths (re-verify at build):
//   sleep    GET /v2/activity/sleep/{sleepId}
//   workout  GET /v2/activity/workout/{workoutId}
//   cycle    GET /v2/cycle/{cycleId}
//   recovery GET /v2/cycle/{cycleId}/recovery   (no recovery-by-recovery-id)
// `fetchSingle` throws a `WhoopApiError` on a non-2xx (incl. a 404 for a since-
// deleted id) so the caller's existing classify/soft-skip path handles it.

export function fetchSleepById(
  accessToken: string,
  sleepId: string,
): Promise<WhoopSleep> {
  return fetchSingle<WhoopSleep>(
    `/v2/activity/sleep/${encodeURIComponent(sleepId)}`,
    accessToken,
    "fetchSleepById",
  );
}

export function fetchWorkoutById(
  accessToken: string,
  workoutId: string,
): Promise<WhoopWorkout> {
  return fetchSingle<WhoopWorkout>(
    `/v2/activity/workout/${encodeURIComponent(workoutId)}`,
    accessToken,
    "fetchWorkoutById",
  );
}

export function fetchCycleById(
  accessToken: string,
  cycleId: string,
): Promise<WhoopCycle> {
  return fetchSingle<WhoopCycle>(
    `/v2/cycle/${encodeURIComponent(cycleId)}`,
    accessToken,
    "fetchCycleById",
  );
}

/**
 * WHOOP v2 has no recovery-by-recovery-id route — a recovery is read through
 * its cycle (`GET /v2/cycle/{cycleId}/recovery`). The recovery webhook carries
 * the cycle id, so the targeted refresh resolves the recovery from there.
 */
export function fetchRecoveryByCycleId(
  accessToken: string,
  cycleId: string,
): Promise<WhoopRecovery> {
  return fetchSingle<WhoopRecovery>(
    `/v2/cycle/${encodeURIComponent(cycleId)}/recovery`,
    accessToken,
    "fetchRecoveryByCycleId",
  );
}

export function fetchBodyMeasurement(
  accessToken: string,
): Promise<WhoopBodyMeasurement> {
  return fetchSingle<WhoopBodyMeasurement>(
    "/v2/user/measurement/body",
    accessToken,
    "fetchBodyMeasurement",
  );
}

export function fetchProfile(accessToken: string): Promise<WhoopProfile> {
  return fetchSingle<WhoopProfile>(
    "/v2/user/profile/basic",
    accessToken,
    "fetchProfile",
  );
}

// ─── Field → Measurement mapping ───────────────────────────────
// The single source of truth is `src/lib/whoop/mapping.md` — keep both in
// sync when adding entries.

/** Milliseconds → minutes. */
const MS_TO_MIN = 1 / 60_000;
/** Kilojoules → kilocalories (workout energy). */
export const KJ_TO_KCAL = 1 / 4.184;

/**
 * A single mapped reading destined for one `Measurement` row. The `source`
 * (`WHOOP`) and `externalId` (`<resource-uuid>:<fieldTag>`) are stamped by the
 * sync layer (W3); the mapper only emits the type/value/unit/measuredAt and
 * the field-tag that disambiguates the several rows derived from one resource.
 */
export interface MappedMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  /** Disambiguator appended to the resource uuid to form the externalId. */
  fieldTag: string;
  /** Per-stage sleep rows carry the SleepStage; everything else omits it. */
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE" | "IN_BED";
  /**
   * Full externalId for rows the mapper must key itself rather than letting
   * the sync layer build `<resource-uuid>:<fieldTag>`. The reconstructed sleep
   * segments (one row per synthetic span) need an index in the key so the
   * several rows of one stage stay distinct under
   * `userId_type_source_externalId`. When set the sync layer uses it verbatim.
   */
  externalId?: string;
  /**
   * `true` on the synthesised per-segment sleep rows whose ORDER is invented:
   * WHOOP's v2 API returns only per-stage duration totals (no onset
   * timestamps), so the timeline is reconstructed in a fixed physiological
   * order. The night is flagged so the UI labels it as an approximate layout
   * and never presents it as measured stage timing.
   */
  reconstructed?: boolean;
}

function round2(n: number): number {
  return parseFloat(n.toFixed(2));
}

/**
 * Map one WHOOP recovery record into Measurement readings. An unscored record
 * (`score === null`) yields nothing. `recovery.score.recovery_score` →
 * `RECOVERY_SCORE` (source WHOOP, distinct from the COMPUTED proxy);
 * `hrv_rmssd_milli` → `HRV_RMSSD` (distinct from the SDNN
 * `HEART_RATE_VARIABILITY`); RHR / SpO2 / skin-temp resolve through the
 * cross-source picker.
 */
export function mapRecovery(r: WhoopRecovery): MappedMeasurement[] {
  if (!r.score) return [];
  const measuredAt = new Date(r.updated_at);
  const out: MappedMeasurement[] = [
    {
      type: "RECOVERY_SCORE",
      value: round2(r.score.recovery_score),
      unit: "score",
      measuredAt,
      fieldTag: "recovery",
    },
    {
      type: "HRV_RMSSD",
      value: round2(r.score.hrv_rmssd_milli),
      unit: "ms",
      measuredAt,
      fieldTag: "hrv_rmssd",
    },
    {
      type: "RESTING_HEART_RATE",
      value: round2(r.score.resting_heart_rate),
      unit: "bpm",
      measuredAt,
      fieldTag: "rhr",
    },
  ];
  if (typeof r.score.spo2_percentage === "number") {
    out.push({
      type: "OXYGEN_SATURATION",
      value: round2(r.score.spo2_percentage),
      unit: "%",
      measuredAt,
      fieldTag: "spo2",
    });
  }
  if (typeof r.score.skin_temp_celsius === "number") {
    out.push({
      type: "SKIN_TEMPERATURE",
      value: round2(r.score.skin_temp_celsius),
      unit: "celsius",
      measuredAt,
      fieldTag: "skin_temp",
    });
  }
  return out;
}

/**
 * Map one WHOOP sleep record into Measurement readings: per-stage
 * `SLEEP_DURATION` rows (ms→min, one per stage), `SLEEP_NEED` (ms→min, summed
 * components), the `SLEEP_*` percentage scores, and `RESPIRATORY_RATE`.
 */
export function mapSleep(s: WhoopSleep): MappedMeasurement[] {
  if (!s.score) return [];
  const measuredAt = new Date(s.end);
  const out: MappedMeasurement[] = [];

  const stages = s.score.stage_summary;

  // WHOOP v2 returns only per-stage DURATION totals (no per-stage onset
  // timestamps, no hypnogram endpoint). Stamping every stage total on the one
  // sleep-END instant makes the hypnogram reconstruct five spans that all touch
  // the night's right edge (the stacked-bar artefact). Since the API never
  // carries an order, we RECONSTRUCT an ordered, contiguous timeline: lay the
  // asleep stages back-to-back from sleep ONSET in a fixed physiological order,
  // emitting one timed row per segment with `measuredAt = that segment's END`.
  // The ORDER is synthetic, so every reconstructed row is flagged
  // `reconstructed: true` and the night DTO advertises it — the UI labels it as
  // an approximate layout and never presents it as measured stage timing.
  //
  // IN_BED stays a single envelope row spanning the whole [start, end] window:
  // the in-bed reader wants the union envelope, not a placed segment. AWAKE is
  // laid as a leading segment from onset so the asleep stages still partition
  // the remaining window.
  const onset = new Date(s.start).getTime();
  // Order the laid-out stages: a brief AWAKE settling-in block, then the asleep
  // stages CORE → DEEP → REM. Each carries its own duration; the shared builder
  // walks the cursor forward so the spans are contiguous and non-overlapping,
  // and lays the IN_BED envelope over the whole window. The order is synthetic
  // (WHOOP gives no per-stage onset), so every laid segment is flagged
  // reconstructed; the same algorithm backs Polar's `mapSleep`.
  out.push(
    ...reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: [
        {
          durationMs: stages.total_awake_time_milli,
          stage: "AWAKE",
          fieldTag: "sleep_awake",
        },
        {
          durationMs: stages.total_light_sleep_time_milli,
          stage: "CORE",
          fieldTag: "sleep_core",
        },
        {
          durationMs: stages.total_slow_wave_sleep_time_milli,
          stage: "DEEP",
          fieldTag: "sleep_deep",
        },
        {
          durationMs: stages.total_rem_sleep_time_milli,
          stage: "REM",
          fieldTag: "sleep_rem",
        },
      ],
      // IN_BED — single envelope row over the whole sleep window. `measuredAt`
      // is the sleep END so `segmentOf` resolves the span back to [start, end];
      // the in-bed union-envelope reader consumes the full window.
      inBed: {
        durationMs: stages.total_in_bed_time_milli,
        measuredAt,
        fieldTag: "sleep_in_bed",
      },
      // The sync layer keys reconstructed rows by this externalId verbatim;
      // the stage tag keeps the several rows of one night distinct under
      // userId_type_source_externalId (one segment per stage, no positional
      // index — an index renumbered on a re-score when a stage's duration
      // flipped 0↔positive, minting fresh ids that double-counted the night).
      externalIdFor: (tag) => `${s.id}:seg:${tag}`,
    }),
  );

  const need = s.score.sleep_needed;
  const totalNeedMilli =
    need.baseline_milli +
    need.need_from_sleep_debt_milli +
    need.need_from_recent_strain_milli +
    need.need_from_recent_nap_milli;
  out.push({
    type: "SLEEP_NEED",
    value: round2(totalNeedMilli * MS_TO_MIN),
    unit: "minutes",
    measuredAt,
    fieldTag: "sleep_need",
  });

  const pct: Array<[string, number | undefined, string]> = [
    ["SLEEP_PERFORMANCE", s.score.sleep_performance_percentage, "sleep_perf"],
    ["SLEEP_EFFICIENCY", s.score.sleep_efficiency_percentage, "sleep_eff"],
    [
      "SLEEP_CONSISTENCY",
      s.score.sleep_consistency_percentage,
      "sleep_consistency",
    ],
  ];
  for (const [type, value, fieldTag] of pct) {
    if (typeof value === "number") {
      out.push({
        type,
        value: round2(value),
        unit: "%",
        measuredAt,
        fieldTag,
      });
    }
  }

  if (typeof s.score.respiratory_rate === "number") {
    out.push({
      type: "RESPIRATORY_RATE",
      value: round2(s.score.respiratory_rate),
      unit: "breaths/min",
      measuredAt,
      fieldTag: "resp_rate",
    });
  }

  if (typeof stages.disturbance_count === "number") {
    out.push({
      type: "SLEEP_DISTURBANCE_COUNT",
      value: stages.disturbance_count,
      unit: "count",
      measuredAt,
      fieldTag: "disturbances",
    });
  }

  return out;
}

/**
 * Map one WHOOP cycle (day) record: `DAY_STRAIN` (distinct from the COMPUTED
 * `STRAIN_SCORE`), `ENERGY_EXPENDITURE_KJ` (kept in native kJ), and the day's
 * whole-cycle `AVERAGE_HEART_RATE` / `MAX_HEART_RATE`. Energy is NOT converted
 * to kcal here — that conversion is for the workout path only.
 */
export function mapCycle(c: WhoopCycle): MappedMeasurement[] {
  if (!c.score) return [];
  const measuredAt = new Date(c.start);
  const out: MappedMeasurement[] = [
    {
      type: "DAY_STRAIN",
      value: round2(c.score.strain),
      unit: "score",
      measuredAt,
      fieldTag: "day_strain",
    },
    {
      type: "ENERGY_EXPENDITURE_KJ",
      value: round2(c.score.kilojoule),
      unit: "kJ",
      measuredAt,
      fieldTag: "energy_kj",
    },
  ];

  // v1.12.8 — the cycle score's average / max heart rate were fetched but
  // dropped before this release. Distinct fieldTags keep them from colliding
  // with the strain / energy rows under the shared cycle `externalId`.
  if (typeof c.score.average_heart_rate === "number") {
    out.push({
      type: "AVERAGE_HEART_RATE",
      value: Math.round(c.score.average_heart_rate),
      unit: "bpm",
      measuredAt,
      fieldTag: "avg_hr",
    });
  }
  if (typeof c.score.max_heart_rate === "number") {
    out.push({
      type: "MAX_HEART_RATE",
      value: Math.round(c.score.max_heart_rate),
      unit: "bpm",
      measuredAt,
      fieldTag: "max_hr",
    });
  }

  return out;
}

/** Metres → centimetres (WHOOP `height_meter` → `User.heightCm`). */
const M_TO_CM = 100;

/**
 * The three destinations a WHOOP body-measurement object fans out to. Unlike
 * the collection mappers it does NOT emit `MappedMeasurement[]` directly,
 * because only `weight` lands in `Measurement` — `maxHeartRate` is a profile
 * constant on `WhoopConnection` and `heightCm` is a one-time `User` profile
 * seed (written only when the user has no height yet). The sync layer routes
 * each piece to its own table.
 */
export interface MappedBodyMeasurement {
  /** Self-reported profile weight in kg, or null when WHOOP omits it. */
  weightKg: number | null;
  /** Profile max heart rate in bpm, or null when WHOOP omits it. */
  maxHeartRate: number | null;
  /** Profile height converted m→cm, or null when WHOOP omits it. */
  heightCm: number | null;
}

/**
 * Map a WHOOP body-measurement object onto its three destinations. The body
 * measurement is a single self-reported profile value, not a timestamped
 * reading, so the sync layer stamps the weight row's `measuredAt` with the
 * fetch time. Every field is optional on the wire — an absent field maps to
 * null and the sync layer skips it.
 */
export function mapBody(b: WhoopBodyMeasurement): MappedBodyMeasurement {
  // WHOOP body fields are self-reported profile data. Guard against absent,
  // non-finite (NaN/Infinity), or non-positive values so a garbage reading
  // never seeds a real WEIGHT measurement or a `User.heightCm` of 0
  // (v1.11.3 QA L1).
  const positive = (n: number | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  return {
    weightKg: positive(b.weight_kilogram) ? round2(b.weight_kilogram) : null,
    maxHeartRate: positive(b.max_heart_rate)
      ? Math.round(b.max_heart_rate)
      : null,
    heightCm: positive(b.height_meter)
      ? round2(b.height_meter * M_TO_CM)
      : null,
  };
}

/**
 * Field→Measurement mapping table (mirror of `mapping.md`). Documents which
 * WHOOP source field becomes which MeasurementType + unit. Used as the
 * single-glance reference and by the mapper tests; the mappers above are the
 * executable form.
 */
export const WHOOP_FIELD_MAP: Record<
  string,
  { type: string; unit: string; factor?: number; note?: string }
> = {
  "recovery.score.recovery_score": { type: "RECOVERY_SCORE", unit: "score" },
  "recovery.score.hrv_rmssd_milli": { type: "HRV_RMSSD", unit: "ms" },
  "recovery.score.resting_heart_rate": {
    type: "RESTING_HEART_RATE",
    unit: "bpm",
  },
  "recovery.score.spo2_percentage": {
    type: "OXYGEN_SATURATION",
    unit: "%",
  },
  "recovery.score.skin_temp_celsius": {
    type: "SKIN_TEMPERATURE",
    unit: "celsius",
  },
  "sleep.score.stage_summary.*_time_milli": {
    type: "SLEEP_DURATION",
    unit: "minutes",
    factor: MS_TO_MIN,
    note: "one row per stage (light→CORE, slow-wave→DEEP, rem→REM, awake→AWAKE, in-bed→IN_BED)",
  },
  "sleep.score.sleep_needed.*_milli": {
    type: "SLEEP_NEED",
    unit: "minutes",
    factor: MS_TO_MIN,
    note: "baseline + debt + strain + nap components summed",
  },
  "sleep.score.sleep_performance_percentage": {
    type: "SLEEP_PERFORMANCE",
    unit: "%",
  },
  "sleep.score.sleep_efficiency_percentage": {
    type: "SLEEP_EFFICIENCY",
    unit: "%",
  },
  "sleep.score.sleep_consistency_percentage": {
    type: "SLEEP_CONSISTENCY",
    unit: "%",
  },
  "sleep.score.respiratory_rate": {
    type: "RESPIRATORY_RATE",
    unit: "breaths/min",
  },
  "cycle.score.strain": { type: "DAY_STRAIN", unit: "score" },
  "cycle.score.kilojoule": { type: "ENERGY_EXPENDITURE_KJ", unit: "kJ" },
  "workout.score.strain": {
    type: "WORKOUT_STRAIN",
    unit: "score",
    note: "preferentially stored in Workout.metadata, not a free-floating Measurement",
  },
  "workout.score.kilojoule": {
    type: "Workout.totalEnergyKcal",
    unit: "kcal",
    factor: KJ_TO_KCAL,
    note: "kJ→kcal for the workout row",
  },
  "body.weight_kilogram": {
    type: "WEIGHT",
    unit: "kg",
    note: "picker ranks a real scale above WHOOP",
  },
  "body.max_heart_rate": {
    type: "WhoopConnection.maxHeartRate",
    unit: "bpm",
    note: "profile constant — stored on the connection, not a Measurement",
  },
  "body.height_meter": {
    type: "User.heightCm",
    unit: "cm",
    factor: M_TO_CM,
    note: "profile seed — written to User.heightCm only when it is null, never as a Measurement",
  },
};
