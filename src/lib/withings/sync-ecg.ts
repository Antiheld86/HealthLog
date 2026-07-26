/**
 * v1.18.11 — Withings ECG / AFib capture.
 * v1.19.0  — full ECG waveform capture (the raw signal samples).
 *
 * The Withings Heart List endpoint (`POST /v2/heart?action=list`) returns one
 * entry per on-device ECG recording made by the ScanWatch family. Each entry
 * carries the device's OWN AFib screening verdict under `ecg.afib`. HealthLog
 * captured none of this before — the signal was fetched by no path and dropped.
 *
 * v1.19.0 additionally fetches each recording's full waveform via the Heart
 * `get` endpoint (`POST /v2/heart?action=get&signalid=<id>`), which returns the
 * micro-volt sample array (`body.signal`) plus `body.sampling_frequency`
 * (Hz) and an optional average `body.heart_rate`. The sample array is raw
 * health data, so it is stored AES-256-GCM ENCRYPTED at rest in the new
 * `EcgRecording.waveformEncrypted` Bytes column (fail-closed crypto, the
 * `CoachMessage.encryptedContent` precedent). The descriptors (frequency,
 * sample count, duration, lead, average HR, AFib verdict) stay plaintext so a
 * future trace renderer reads them without a per-row decrypt. RENDERING UI IS
 * OUT OF SCOPE for v1.19.0 — this remains ingest-only.
 *
 * This mirrors the v1.10.0 categorical-event treatment the Apple-Health bridge
 * already gives the Watch's irregular-rhythm notification: HealthLog stores
 * ONLY the verdict the device's certified algorithm produced. It never sees a
 * raw ECG waveform, never re-classifies, and never emits a diagnosis. Each
 * recording lands as one `IRREGULAR_RHYTHM_NOTIFICATION` Measurement row with
 * `value = 1` (one fired recording), `unit = "event"`, and the device verdict
 * in the `rhythmClassification` column — the SAME enum + column + CHECK
 * constraint (migration 0105) the Apple path uses, so there is NO migration
 * and no iOS-contract change. The rows flow to `/api/sync/changes` under the
 * `WITHINGS` source like every other server-side fetch.
 *
 * AFib code → verdict (Withings Heart List `ecg.afib`):
 *   - 0 → NOT_DETECTED   (algorithm ran, no AFib flagged)
 *   - 1 → IRREGULAR      (possible AFib flagged — AWARENESS ONLY, never a
 *                         HealthLog diagnosis)
 *   - any other code (inconclusive / poor recording / high-HR) → INCONCLUSIVE
 *
 * The Heart List endpoint is served under the `user.metrics` scope (already
 * requested for every Withings connection since W5d), so — unlike the
 * sleep/activity endpoints — it needs no `user.activity` scope gate.
 *
 * Idempotency: each recording carries a stable `signalid`; the externalId is
 * `withings:ecg:<userId>:<signalid>` (or the timestamp when a recording omits
 * `signalid`). Upsert keys on `(userId, type, source = WITHINGS, externalId)`
 * so a re-sync overwrites the recording's verdict in place rather than
 * inserting a duplicate.
 */
import type {
  MeasurementType,
  RhythmClassification,
} from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import { encryptWaveformToBytes } from "./ecg-waveform-codec";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";

import {
  WithingsApiError,
  classifyWithingsResponse,
} from "./response-classifier";
import {
  WITHINGS_LEG_ECG,
  getValidToken,
  recordWithingsSyncFailure,
} from "./sync";
import {
  isReauthRequired,
  recordSyncFailure,
  recordSyncSuccess,
} from "@/lib/integrations/status";

const WITHINGS_HEART_URL = "https://wbsapi.withings.net/v2/heart";

/** The categorical EVENT type every ECG recording lands under. */
const ECG_TYPE: MeasurementType = "IRREGULAR_RHYTHM_NOTIFICATION";
/** Canonical unit for an EVENT row (one fired recording). */
const ECG_UNIT = "event";

/**
 * Default backfill window for the first ECG sync of a connection. Matches the
 * sleep/activity ingest windows so a reconnect lights up 30 days of history.
 */
const ECG_BACKFILL_DAYS = 30;

/**
 * One Heart List entry from `POST /v2/heart?action=list`. The AFib verdict
 * lives under `ecg.afib`; `signalid` is the stable per-recording id used for
 * the externalId. `timestamp` is unix seconds.
 */
export interface WithingsHeartEntry {
  timestamp: number;
  ecg?: {
    signalid?: number;
    afib?: number;
  } | null;
}

/**
 * Map a Withings `ecg.afib` code to the HealthLog `RhythmClassification`
 * verdict. Returns `null` when the entry carries no ECG / no afib code so the
 * caller can skip a non-ECG heart entry (e.g. a manual BP measurement) without
 * an error.
 */
export function mapWithingsAfib(
  afib: number | null | undefined,
): RhythmClassification | null {
  if (typeof afib !== "number" || !Number.isFinite(afib)) return null;
  switch (afib) {
    case 0:
      return "NOT_DETECTED";
    case 1:
      return "IRREGULAR";
    default:
      // Inconclusive / poor recording / high-HR — the device could not return
      // a clean positive/negative AFib verdict.
      return "INCONCLUSIVE";
  }
}

/**
 * Fetch the Heart List for the given window. Returns the raw entries (no DB
 * write) so the caller composes the upsert step. Paginates via the response's
 * `more` / `offset` like the Measure endpoint.
 */
export async function fetchWithingsHeartList(
  accessToken: string,
  startdate: number,
  enddate: number,
): Promise<WithingsHeartEntry[]> {
  const results: WithingsHeartEntry[] = [];
  let offset = 0;
  let pageCount = 0;

  while (true) {
    const params = new URLSearchParams({
      action: "list",
      startdate: String(startdate),
      enddate: String(enddate),
      offset: String(offset),
    });

    const pageStart = performance.now();
    const res = await safeFetch(WITHINGS_HEART_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${accessToken}`,
      },
      body: params.toString(),
    });
    const json = await res.json();
    const verdict = classifyWithingsResponse(res.status, json);
    getEvent()?.addExternalCall({
      service: "withings",
      method: `fetchWithingsHeartList(page=${pageCount})`,
      duration_ms: Math.round(performance.now() - pageStart),
      status: res.status,
      error: verdict.classification === "success" ? undefined : verdict.reason,
    });
    if (verdict.classification !== "success") {
      throw new WithingsApiError({
        verb: "heart",
        classification: verdict.classification,
        withingsStatus: verdict.withingsStatus,
        reason: verdict.reason,
        upstreamError: typeof json?.error === "string" ? json.error : undefined,
      });
    }

    const body = json.body ?? {};
    const series: WithingsHeartEntry[] = body.series ?? [];
    results.push(...series);

    const hasMore = body.more === true || body.more === 1;
    if (!hasMore) break;
    const nextOffset = Number(body.offset);
    if (!Number.isFinite(nextOffset) || nextOffset <= offset) break;
    offset = nextOffset;
    pageCount += 1;
    if (pageCount > 1000) break;
  }

  return results;
}

/**
 * The Heart `get` response body for a single ECG signal. `signal` is the
 * micro-volt sample array; `sampling_frequency` is the rate in Hz used to map
 * a sample index to its time offset. `heart_rate` (average BPM for the strip)
 * and `wavelets` are optional and source-version dependent — we capture the
 * average HR when present and ignore the wavelet transform.
 */
export interface WithingsHeartSignal {
  signal?: number[] | null;
  sampling_frequency?: number | null;
  heart_rate?: number | null;
}

/**
 * Fetch the full waveform for one ECG recording via `action=get`. Returns the
 * raw signal body (no DB write) so the caller composes the encrypt + persist
 * step. Returns `null` when the recording carries no usable signal array so
 * the caller can skip waveform storage without failing the whole sync.
 */
export async function fetchWithingsHeartSignal(
  accessToken: string,
  signalId: number,
): Promise<WithingsHeartSignal | null> {
  const params = new URLSearchParams({
    action: "get",
    signalid: String(signalId),
  });

  const callStart = performance.now();
  const res = await safeFetch(WITHINGS_HEART_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${accessToken}`,
    },
    body: params.toString(),
  });
  const json = await res.json();
  const verdict = classifyWithingsResponse(res.status, json);
  getEvent()?.addExternalCall({
    service: "withings",
    method: "fetchWithingsHeartSignal",
    duration_ms: Math.round(performance.now() - callStart),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new WithingsApiError({
      verb: "heart",
      classification: verdict.classification,
      withingsStatus: verdict.withingsStatus,
      reason: verdict.reason,
      upstreamError: typeof json?.error === "string" ? json.error : undefined,
    });
  }

  const body = json.body ?? {};
  const signal = Array.isArray(body.signal)
    ? body.signal.filter((n: unknown): n is number => typeof n === "number")
    : null;
  if (!signal || signal.length === 0) return null;

  return {
    signal,
    sampling_frequency:
      typeof body.sampling_frequency === "number"
        ? body.sampling_frequency
        : null,
    heart_rate: typeof body.heart_rate === "number" ? body.heart_rate : null,
  };
}

/**
 * Fetch + encrypt + persist one ECG waveform. Idempotent: upserts on
 * `(userId, source, externalRecordingId)` so a re-sync overwrites the same
 * recording in place rather than inserting a duplicate. Returns `true` when a
 * waveform row was written, `false` when the recording carried no usable
 * signal (nothing to store). Throws on an upstream / persist error so the
 * caller can warn without failing the verdict ingest.
 */
async function captureEcgWaveform(params: {
  userId: string;
  accessToken: string;
  signalId: number;
  externalRecordingId: string;
  recordedAt: Date;
  classification: RhythmClassification;
  measurementId: string | null;
}): Promise<boolean> {
  const signal = await fetchWithingsHeartSignal(
    params.accessToken,
    params.signalId,
  );
  if (!signal || !signal.signal || signal.signal.length === 0) {
    return false;
  }

  const samples = signal.signal;
  const samplingFrequency =
    typeof signal.sampling_frequency === "number" &&
    Number.isFinite(signal.sampling_frequency) &&
    signal.sampling_frequency > 0
      ? Math.round(signal.sampling_frequency)
      : 0;
  const sampleCount = samples.length;
  const durationSeconds =
    samplingFrequency > 0 ? sampleCount / samplingFrequency : null;
  const averageHeartRate =
    typeof signal.heart_rate === "number" && Number.isFinite(signal.heart_rate)
      ? Math.round(signal.heart_rate)
      : null;

  // Encrypt the raw sample array BEFORE it ever reaches the row. Fail-closed:
  // a crypto error throws here and the waveform is never written as plaintext.
  const waveformEncrypted = encryptWaveformToBytes(samples);

  // Build the `data` object field-by-field (no mass assignment); `userId` is
  // the integration owner narrowed by the caller, never a client field.
  await prisma.ecgRecording.upsert({
    where: {
      userId_source_externalRecordingId: {
        userId: params.userId,
        source: "WITHINGS",
        externalRecordingId: params.externalRecordingId,
      },
    },
    create: {
      userId: params.userId,
      source: "WITHINGS",
      externalRecordingId: params.externalRecordingId,
      recordedAt: params.recordedAt,
      waveformEncrypted,
      samplingFrequency,
      sampleCount,
      durationSeconds,
      averageHeartRate,
      rhythmClassification: params.classification,
      measurementId: params.measurementId,
    },
    update: {
      recordedAt: params.recordedAt,
      waveformEncrypted,
      samplingFrequency,
      sampleCount,
      durationSeconds,
      averageHeartRate,
      rhythmClassification: params.classification,
      measurementId: params.measurementId,
    },
  });

  return true;
}

/**
 * Sync ECG / AFib recordings for a single user. Always walks at least the
 * trailing 30 days and widens that catch-up to include an older webhook source
 * window when supplied. Writes
 * one `IRREGULAR_RHYTHM_NOTIFICATION` row per ECG recording tagged with the
 * device's AFib verdict. Returns the number of upserted rows.
 *
 * Park behaviour mirrors the other Withings syncs — a connection at
 * `error_reauth` short-circuits before the upstream call.
 */
export async function syncUserEcg(
  userId: string,
  options: { startdate?: number; enddate?: number } = {},
): Promise<number> {
  if (await isReauthRequired(userId, "withings")) {
    getEvent()?.addWarning(
      `withings ecg sync skipped for ${userId}: parked at error_reauth`,
    );
    return 0;
  }

  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) {
    if (await isReauthRequired(userId, "withings")) return 0;
    const connection = await prisma.withingsConnection.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!connection) return 0;
    throw new Error("Withings ECG token unavailable");
  }

  const now = new Date();
  const defaultStartUnix = Math.floor(
    (now.getTime() - ECG_BACKFILL_DAYS * 24 * 60 * 60 * 1000) / 1000,
  );
  const defaultEndUnix = Math.floor(now.getTime() / 1000);
  const hasProviderWindow =
    Number.isSafeInteger(options.startdate) &&
    Number.isSafeInteger(options.enddate) &&
    options.startdate! >= 0 &&
    options.startdate! <= options.enddate!;
  const startUnix = hasProviderWindow
    ? Math.min(defaultStartUnix, options.startdate!)
    : defaultStartUnix;
  const endUnix = hasProviderWindow
    ? Math.max(defaultEndUnix, options.enddate!)
    : defaultEndUnix;

  let entries: WithingsHeartEntry[];
  try {
    entries = await fetchWithingsHeartList(
      tokenInfo.accessToken,
      startUnix,
      endUnix,
    );
  } catch (err) {
    // The Heart List endpoint rides the user.metrics scope, so a 403 here is a
    // genuine token-revoked / reauth case rather than the activity-scope skip
    // the sleep/activity syncs guard against.
    const withingsStatus =
      err instanceof WithingsApiError ? err.withingsStatus : undefined;
    if (withingsStatus === 403) {
      await recordSyncFailure({
        userId,
        integration: "withings",
        kind: "reauth_required",
        message: err instanceof Error ? err.message : String(err),
        errorCode: "403",
        leg: WITHINGS_LEG_ECG,
      });
      throw err;
    }
    await recordWithingsSyncFailure(userId, err, WITHINGS_LEG_ECG);
    throw err;
  }

  let imported = 0;
  let waveformsCaptured = 0;
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];
  let sourceWriteError: { cause: unknown } | null = null;

  for (const entry of entries) {
    const classification = mapWithingsAfib(entry.ecg?.afib);
    if (!classification) {
      // Not an ECG entry (or no afib verdict) — skip silently.
      continue;
    }
    const measuredAt = new Date(entry.timestamp * 1000);
    const numericSignalId = entry.ecg?.signalid;
    const signalId = numericSignalId ?? `ts-${entry.timestamp}`;
    const externalId = `withings:ecg:${userId}:${signalId}`;

    let measurementId: string | null = null;
    try {
      const row = await prisma.measurement.upsert({
        where: {
          userId_type_source_externalId: {
            userId,
            type: ECG_TYPE,
            source: "WITHINGS",
            externalId,
          },
        },
        create: {
          userId,
          type: ECG_TYPE,
          value: 1,
          unit: ECG_UNIT,
          measuredAt,
          source: "WITHINGS",
          externalId,
          rhythmClassification: classification,
        },
        update: {
          // The recording's value is fixed at 1; only the verdict can change if
          // Withings re-classifies a signal. Overwrite it in place.
          rhythmClassification: classification,
          measuredAt,
          syncVersion: { increment: 1 },
        },
        select: { id: true },
      });
      measurementId = row.id;
      touched.push({ type: ECG_TYPE, measuredAt });
      imported++;
    } catch (err) {
      getEvent()?.addWarning(
        `withings ecg: failed to upsert recording (${classification}, ${measuredAt.toISOString()}): ${err}`,
      );
      sourceWriteError ??= { cause: err };
      continue;
    }

    // v1.19.0 — capture the full waveform. Only a recording with a numeric
    // `signalid` can be fetched (the `ts-` fallback has no signal to GET). A
    // waveform-fetch / persist failure never fails the verdict ingest — the
    // EVENT row already landed above.
    if (typeof numericSignalId === "number") {
      try {
        const captured = await captureEcgWaveform({
          userId,
          accessToken: tokenInfo.accessToken,
          signalId: numericSignalId,
          externalRecordingId: String(numericSignalId),
          recordedAt: measuredAt,
          classification,
          measurementId,
        });
        if (captured) waveformsCaptured++;
      } catch (err) {
        getEvent()?.addWarning(
          `withings ecg: failed to capture waveform for signal ${numericSignalId}: ${err}`,
        );
      }
    }
  }

  annotate({
    action: { name: "withings.ecg.sync" },
    meta: {
      withings_ecg_verdicts_imported: imported,
      withings_ecg_waveforms_captured: waveformsCaptured,
    },
  });

  // Refresh the persistent rollup tier for every distinct (type, day) touched,
  // then drop the per-metric assessment caches the new events dirty.
  try {
    const keys = collapseToTypeDayKeys(touched);
    for (const k of keys) {
      await recomputeBucketsForMeasurement(userId, k.type, k.measuredAt);
    }
    invalidateStatusInsightsForTypes(
      userId,
      keys.map((k) => k.type),
    ).catch((err) => {
      getEvent()?.addWarning(
        `withings ecg: status-insight invalidate failed for ${userId}: ${err}`,
      );
    });
  } catch (err) {
    getEvent()?.addWarning(
      `withings ecg: rollup recompute failed for ${userId}: ${err}`,
    );
  }

  if (sourceWriteError) {
    await recordWithingsSyncFailure(
      userId,
      sourceWriteError.cause,
      WITHINGS_LEG_ECG,
    );
    throw sourceWriteError.cause;
  }

  await recordSyncSuccess(userId, "withings", { leg: WITHINGS_LEG_ECG });
  return imported;
}
