/**
 * OpenAPI path table — dashboard snapshot, comprehensive insights, analytics range, metric status, derived metrics, correlations.
 *
 * Schema declarations live in `./schemas`; this module is the path orchestrator.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";
import {
  AI_CONSENT_REQUIRED_DESCRIPTION,
  MODULE_DISABLED_DESCRIPTION,
  dataEnvelope,
  errorEnvelope,
  moduleDisabledResponse,
  recordRefusal,
  stdResponses,
} from "../shared";
import {
  insightsCardsResponse,
  insightsComprehensiveResponse,
  metricStatusQuery,
  metricStatusResponse,
  biomarkerAssessmentQuery,
  biomarkerAssessmentResponse,
  derivedMetricQuery,
  derivedMetricResponse,
  derivedBatchQuery,
  derivedBatchResponse,
  correlationDiscoveryResponse,
  correlationPatternListResponse,
  updateCorrelationPatternRequest,
  updateCorrelationPatternResponse,
  glp1PlateauResponse,
  insightStatusQuery,
  insightStatusResponse,
  medicationComplianceStatusResponse,
  analyticsRangeQuery,
  analyticsRangeResponse,
  insightsPregenerateRequest,
  insightsPregenerateResponse,
  dashboardSnapshotResponse,
  ecgListResponse,
  ecgIngestRequest,
  ecgIngestResponse,
  ecgDetailQuery,
  ecgDetailResponse,
  rhythmEventsResponse,
  analyticsQuery,
  analyticsResponse,
  insightsSettingsResponse,
  insightsSettingsPutRequest,
  targetsResponse,
} from "./schemas";

export const insightsPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/dashboard/snapshot": {
    get: {
      tags: ["Dashboard"],
      summary: "Unified dashboard first-paint snapshot",
      description:
        "Assembles every above-the-fold tile field in one round-trip from the rollup / mood / widget helpers plus a read-only lift of the pre-generated daily briefing. Two-phase: `tiles` always present, `extras` nullable on a rollup-coverage miss. No LLM is reachable from this path. Cookie or Bearer auth.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Dashboard snapshot.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                dashboardSnapshotResponse,
                "DashboardSnapshotResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/comprehensive": {
    get: {
      tags: ["Insights"],
      summary: "Comprehensive AI insights bundle",
      description:
        "Full Insights surface — daily briefing, recommendations with rationale, optional weekly report + storyboard annotations. Strict-schema validated server-side. Requires an active ConsentReceipt when the resolved provider chain egresses via the operator's server-managed key (see POST /api/consent/ai).",
      responses: {
        "200": {
          description: "Insights bundle.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsComprehensiveResponse,
                "InsightsComprehensiveResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        ...recordRefusal(AI_CONSENT_REQUIRED_DESCRIPTION),
      },
    },
  },
  "/api/insights/cards": {
    get: {
      tags: ["Insights"],
      summary: "Insight cards (iOS adapter)",
      description:
        "v1.4.31 — the native-client adapter over the same alert rule engine the web comprehensive surface consumes: measurements, BP-in-target, weight trend, pulse, and cadence-aware medication compliance are fed through `generateAlerts()` and each resulting `HealthAlert` is re-shaped to the iOS Insight card model. Deterministic — no LLM call on this path. Module-gated on `insights` and the operator `insightStatus` assistant surface. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The list of insight cards (possibly empty).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsCardsResponse,
                "InsightsCardsEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/insights/pregenerate": {
    post: {
      tags: ["Insights"],
      summary: "Warm all AI assessments for the calling user",
      description:
        "v1.8.7.1 — enqueue a full warm of every AI assessment for the authenticated user (comprehensive insight + the seven specialised status cards + every data-bearing generic metric assessment) in the active locale, so the read-only status GETs serve cached text instantly. Returns immediately; the generation runs out of band on the worker. Empty metrics and provider-less accounts never trigger an LLM call. Short anti-spam bucket (`insights-warm:<userId>`, one warm per 3 minutes) → 429 on a tight loop. Auth via cookie or Bearer; `userId` is taken from the session, never the body.",
      requestBody: {
        required: false,
        content: {
          "application/json": { schema: insightsPregenerateRequest },
        },
      },
      responses: {
        "200": {
          description:
            "Warm accepted and enqueued. The work runs on the worker; poll the read-only status routes for the text.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsPregenerateResponse,
                "InsightsPregenerateResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/analytics": {
    get: {
      tags: ["Analytics"],
      summary: "The full analytics envelope (two slices behind one path)",
      description:
        "The oldest composite read in the application. `?slice=summaries` answers the slim slice — per-type summaries and the freshness map, resolved from two SQL passes over the rollup tier. Everything else answers the thick default: the same summaries plus BMI, the blood-pressure in-target windows, per-context glucose and the clinical glucose panel, the three correlation hypotheses, the full health-score report and the trailing-30-day sleep-stage breakdown. No LLM is reachable from either path. Both are served through a stale-while-revalidate cache, and the DEFAULT slice's cache key includes the reader's locale, because the correlation narration is localised prose. Two behaviours worth knowing before integrating: the thick slice RECORDS the health score it computes, so this read is not side-effect-free, and it kicks off a background rollup refresh it deliberately does not await, so a reading logged seconds ago can be missing from the very first request after it lands and present on the next. Module handling is per BLOCK, not per request: the glucose blocks go null when the glucose module is off, and the health score simply drops the pillars whose modules are off. Cookie or Bearer auth; the caller is always resolved as themselves, so this read cannot be delegated to a shared record.",
      requestParams: { query: analyticsQuery },
      responses: {
        "200": {
          description:
            "`AnalyticsDefaultSlice`, or `AnalyticsSummariesSlice` when `slice=summaries`. `Cache-Control` is the bfcache-friendly `private, max-age=0, must-revalidate` rather than `no-store`.",
          content: {
            "application/json": {
              schema: dataEnvelope(analyticsResponse, "AnalyticsEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/settings": {
    get: {
      tags: ["Insights"],
      summary: "Read the account's AI-provider settings",
      description:
        "Returns the account's own provider connection state and privacy mode alongside PRESENCE-ONLY flags for the operator's shared key and shared ChatGPT connection. No key, token or account id is ever on this wire. Cookie or Bearer auth; the caller is always resolved as themselves, so this read cannot be delegated to a shared record.",
      responses: {
        "200": {
          description: "The settings.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightsSettingsResponse,
                "InsightsSettingsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Insights"],
      summary: "Update the account's AI privacy mode",
      description:
        "Writes `privacyMode` and nothing else. Changing it clears the cached insight text and its timestamp so the next generation runs under the new mode. The body is inspected key by key rather than Zod-parsed: an unknown key is ignored rather than refused, and a body that recognises nothing is refused with 422 `No changes` rather than answered as a no-op — so a client cannot tell a typo'd field name from a rejected value except by reading the message. Body capped at 64 KiB. Cookie or Bearer auth; not delegable.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: insightsSettingsPutRequest },
        },
      },
      responses: {
        "200": {
          description: "Saved.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ updated: z.literal(true) }),
                "InsightsSettingsUpdatedEnvelope",
              ),
            },
          },
        },
        "422": {
          description:
            "`Invalid privacy mode` when `privacyMode` was a string outside the two accepted values, or `No changes` when the body carried nothing this endpoint writes. Single-message envelope with no issue list — this route validates by hand rather than through Zod.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "401": stdResponses["401"],
        "429": stdResponses["429"],
      },
    },
  },
  "/api/insights/targets": {
    get: {
      tags: ["Insights"],
      summary: "Per-metric target tiles + consistency strips",
      description:
        "The whole targets page in one read: a tile per metric with its band, its current and 30-day-average values, and the seven-day consistency strip behind it, plus the page summary, the diastolic companion figures and the profile facts every band was resolved from. Pure compute over the record's own data — no provider anywhere on the path. Stale-while-revalidate: past the fresh window the prior body serves immediately while one background rebuild warms the cell, and a write hard-evicts the bucket so the account's own action lands on the next read. Delegable at MANAGE level over the whole record: the walk spans vitals, sleep, medications, mood and glucose, so a section-scoped grant is refused rather than served a filtered page. Not module-gated as a whole; a tile whose data does not exist is simply absent. Cookie or Bearer auth.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The target tiles and their page summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(targetsResponse, "TargetsEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/analytics/range": {
    get: {
      tags: ["Analytics"],
      summary: "Single-metric period-over-period range delta",
      description:
        "v1.9.0 — returns the current-window aggregate, the previous comparable window, and the composed delta for ONE metric type over a `7d` / `30d` / `90d` / `1y` range. Single-type by construction (the metric page is single-metric), so the read is one rollup-tier call covering the trailing 2N days sliced into the two halves — no per-type fan-out. Additive route; the `/api/analytics` envelope is unchanged. Auth via cookie or Bearer.",
      requestParams: {
        query: analyticsRangeQuery,
      },
      responses: {
        "200": {
          description: "Current + previous window aggregates and the delta.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                analyticsRangeResponse,
                "AnalyticsRangeResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/blood-pressure-status": {
    get: {
      tags: ["Insights"],
      summary: "Blood-pressure assessment",
      description:
        "Data-driven plain-language assessment of the user's recent blood-pressure readings. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "BloodPressureStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/pulse-status": {
    get: {
      tags: ["Insights"],
      summary: "Pulse assessment",
      description:
        "Data-driven plain-language assessment of the user's recent resting-pulse readings. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "PulseStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/weight-status": {
    get: {
      tags: ["Insights"],
      summary: "Weight assessment",
      description:
        "Data-driven plain-language assessment of the user's recent weight trend. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "WeightStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/bmi-status": {
    get: {
      tags: ["Insights"],
      summary: "BMI assessment",
      description:
        "Data-driven plain-language assessment of the user's body-mass index. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "BmiStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/mood-status": {
    get: {
      tags: ["Insights"],
      summary: "Mood assessment",
      description:
        "Data-driven plain-language assessment of the user's recent mood entries. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                insightStatusResponse,
                "MoodStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/medication-compliance-status": {
    get: {
      tags: ["Insights"],
      summary: "Medication-compliance assessment",
      description:
        "Data-driven plain-language assessment of the user's medication compliance — an overall `summary` plus a per-medication note array. Read-only: a cache miss warms a generation out of band and serves the last-good envelope meanwhile (stale-while-revalidate). Auth via cookie or Bearer.",
      requestParams: {
        query: insightStatusQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description:
            "Compliance assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationComplianceStatusResponse,
                "MedicationComplianceStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/metric-status": {
    get: {
      tags: ["Insights"],
      summary: "Generic per-HealthKit-metric assessment",
      description:
        "v1.8.7.1 — data-driven plain-language assessment for any registered HealthKit metric (resting heart rate, sleep, glucose, body composition, gait, audio exposure, …). One generic route covering ~30 metric pages via archetype prompt templates + per-metric metadata. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate). An unknown `metric` 422s against the closed registry enum. Auth via cookie or Bearer.",
      requestParams: {
        query: metricStatusQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                metricStatusResponse,
                "MetricStatusResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/biomarker-assessment": {
    get: {
      tags: ["Insights"],
      summary: "Per-biomarker assessment",
      description:
        "Data-driven plain-language assessment for one user-scoped lab biomarker, reading its `LabResult` history. Identical envelope to the metric-status card so the `InsightStatusCard` consumes it unchanged. Read-only: a cache miss warms a generation out of band and serves the last-good text meanwhile (stale-while-revalidate); the assessment regenerates only when a new reading lands. A marker with no numeric readings returns `insufficient` without an LLM call. Auth via cookie or Bearer.",
      requestParams: {
        query: biomarkerAssessmentQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Assessment envelope (fresh, cached, or preparing).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                biomarkerAssessmentResponse,
                "BiomarkerAssessmentResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/derived": {
    get: {
      tags: ["Insights"],
      summary: "Derived wellness metric (compute-once)",
      description:
        "v1.10.0 — the compute-once `Derived<T>` value for any registered derived wellness metric (personal typical-range vitals baseline, cardio-fitness band, vascular-age delta, sleep score, readiness, coincident-deviation flag). One generic route over a closed registry enum; an unknown `metric` 422s. Pure compute over the rollup tier with a per-type live fallback on a coverage miss — no LLM call, no narrative, no cache table. Returns the flat `Derived<T>` union so the native client can decode one stable shape and combine values across metrics. Auth via cookie or Bearer.",
      requestParams: {
        query: derivedMetricQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The flat derived-metric value (ok or insufficient).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                derivedMetricResponse,
                "DerivedMetricResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/derived/batch": {
    get: {
      tags: ["Insights"],
      summary: "Derived wellness metrics (batched compute-once)",
      description:
        "v1.10.0 — resolve several derived wellness metrics in ONE request. The `metrics` CSV names the metrics (a `metric:type` token sub-targets a VITALS_BASELINE vital); the server fans out under a bounded limiter with the profile loaded once and returns a map keyed by the per-request token. Collapses the Insights cold-mount fan-out of 14+ independent single-metric requests — the pool-starvation class that surfaces as a hang-then-recover. The single-metric route stays for the per-score detail pages. Auth via cookie or Bearer.",
      requestParams: {
        query: derivedBatchQuery,
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The map of derived-metric values, keyed by token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                derivedBatchResponse,
                "DerivedBatchResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/glp1-plateau": {
    get: {
      tags: ["Insights"],
      summary: "GLP-1 weight-plateau detection",
      description:
        "Deterministic (non-LLM) weight-plateau read for users on an active GLP-1 medication: flags a stable dose held for at least the trailing window with no weight loss beyond the threshold. `plateau` is null whenever the condition does not hold, so clients hide the note cleanly. Association only — no verdict, no dose advice. Auth via cookie or Bearer.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Plateau context (or null) plus the window length.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                glp1PlateauResponse,
                "InsightsGlp1PlateauResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/ecg": {
    get: {
      tags: ["Insights"],
      summary: "ECG recording list (metadata only)",
      description:
        "v1.28.50 — the authenticated user's ECG recordings as a cheap, index-covered metadata list (recorded time, duration, sampling rate, sample count, average heart rate, lead, and the DEVICE's own rhythm classification). NEVER decrypts or returns the waveform — the per-recording strip is fetched on demand from GET /api/insights/ecg/{id}. Reflects only the recording device's certified on-device classification, verbatim; HealthLog never re-classifies an ECG or produces a diagnosis. Data-availability-gated: an empty account returns `hasRecordings: false`. Module-gated on `insights` and the operator `insightStatus` assistant surface; no LLM call. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The ECG recording list (possibly empty).",
          content: {
            "application/json": {
              schema: dataEnvelope(ecgListResponse, "EcgListResponseEnvelope"),
            },
          },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
    post: {
      tags: ["Insights"],
      summary: "Ingest one ECG recording",
      description:
        "The live ECG ingest: one Apple Watch recording per request, for a client draining its HealthKit ECG observer. Before this existed, a watch ECG could only reach HealthLog inside a full `export.zip`. One recording per request because a 30 s / 512 Hz strip is ~15 360 samples. Samples are INTEGER MICRO-VOLTS (convert from HealthKit's Volts), stored AES-256-GCM encrypted; `sampleCount` and `durationSeconds` are derived server-side. The `classification` is the device's own verdict stored verbatim — HealthLog never reads the waveform to produce or revise one. `source` accepts `APPLE_HEALTH` only; `userId` comes from the session and is never a body field. Unknown body keys are rejected with a 422 naming them. No `Idempotency-Key` is needed: the recording carries its own identity, so a retry resolves to the same row by construction — see `status` for what a re-post reports. Limits: 32 768 samples, 2 MB body, 60 recordings per minute per user. Module-gated on `insights` and the operator `insightStatus` assistant surface; no LLM call. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: ecgIngestRequest },
        },
      },
      responses: {
        "200": {
          description:
            "The recording was already stored: `updated` (same id, overwritten in place) or `duplicate` (already present under a different id, nothing written).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                ecgIngestResponse,
                "EcgIngestResponseEnvelope",
              ),
            },
          },
        },
        "201": {
          description: "A new recording was stored (`status: inserted`).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                ecgIngestResponse,
                "EcgIngestCreatedEnvelope",
              ),
            },
          },
        },
        ...moduleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/insights/ecg/{id}": {
    get: {
      tags: ["Insights"],
      summary: "One ECG recording with waveform",
      description:
        "v1.28.50 — one recording's decrypted waveform plus metadata and the DEVICE's verbatim classification. Ownership is narrowed in the query where (`{ id, userId }`) so a cross-user read is structurally impossible; a foreign or unknown id 404s (existence sealed). The waveform is AES-256-GCM at rest, decrypted through the fail-closed codec. By default the ~9000-sample strip is min/max-decimated to ~2500 display points so R-wave peaks survive; `?full=1` returns the raw array. HealthLog does not interpret the trace, measure intervals, annotate beats, or emit a verdict of its own. Module-gated on `insights` and the operator `insightStatus` assistant surface; no LLM call. `no-store`. Auth via cookie or Bearer.",
      requestParams: {
        path: z.object({
          id: z.string().describe("The ECG recording id (cuid)."),
        }),
        query: ecgDetailQuery,
      },
      responses: {
        "200": {
          description:
            "The recording's waveform + metadata + device classification.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                ecgDetailResponse,
                "EcgDetailResponseEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "No ECG recording with that id for the authenticated user (existence sealed — a foreign id is indistinguishable from a missing one).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/insights/rhythm-events": {
    get: {
      tags: ["Insights"],
      summary: "Device-flagged rhythm/HR/steadiness event timeline",
      description:
        "v1.10.0 (WX-B) — the authenticated user's timeline of device-flagged EVENT rows: irregular-rhythm / high-HR / low-HR / walking-steadiness / breathing-disturbance notifications the user's wearable (Apple Watch / Withings ScanWatch) already produced and synced. AWARENESS / SCREENING of the DEVICE's own decision — HealthLog stores and reflects ONLY the classification result the device's certified on-device algorithm emitted, verbatim; it never re-classifies and never produces a HealthLog diagnosis. `classification` carries the full six-value verdict set (the three ECG verdicts plus the two walking-steadiness severities plus the neutral FIRED verdict) — a distinct, wider enum than the three-value one on GET /api/insights/ecg. Data-availability-gated: an account with no event rows returns `hasEvents: false`. Module-gated on `insights` and the operator `insightStatus` assistant surface; no LLM call. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "The device-flagged event timeline (possibly empty).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                rhythmEventsResponse,
                "RhythmEventsResponseEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/insights/correlations": {
    get: {
      tags: ["Insights"],
      summary: "Correlation discovery (FDR-controlled)",
      description:
        "v1.10.0 — scans a curated behaviour × outcome matrix (daylight / mood / glucose / BP / steps × sleep / HRV / resting HR / weight), lag-joins each behaviour day to the next day's outcome, runs Pearson with the exact Student-t p-value, and applies Benjamini-Hochberg FDR control across every tested pair. Only statistically-defensible pairs surface, each carrying n, r, p, and the BH-adjusted q. Descriptive, never causal. Gated by the operator `correlations` assistant surface. Auth via cookie or Bearer.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The discovered correlations + the tested-pair count.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                correlationDiscoveryResponse,
                "CorrelationDiscoveryResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/patterns": {
    get: {
      tags: ["Insights"],
      summary: "List current correlation patterns",
      description:
        "Returns the authenticated account's currently accepted persisted correlation identities, evidence, and dismissal timestamps.",
      responses: {
        "200": {
          description: "Current persisted correlation patterns.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                correlationPatternListResponse,
                "CorrelationPatternListResponseEnvelope",
              ),
            },
          },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
  "/api/insights/patterns/{id}": {
    patch: {
      tags: ["Insights"],
      summary: "Update correlation pattern dismissal",
      description:
        "Dismisses or restores one current account-owned pattern. A dismissal remains effective until the accepted evidence changes materially.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: updateCorrelationPatternRequest },
        },
      },
      responses: {
        "200": {
          description: "Updated dismissal decision.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                updateCorrelationPatternResponse,
                "UpdateCorrelationPatternResponseEnvelope",
              ),
            },
          },
        },
        "404": {
          description: "No current pattern with that id for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        ...stdResponses,
      },
    },
  },
};
