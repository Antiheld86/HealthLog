/**
 * OpenAPI route table — cycle tracking (day logs, periods, calendar, insights, prefs).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import {
  flowLevelEnum,
  ovulationTestEnum,
  cervicalMucusEnum,
  secondarySymptomEnum,
  cervixPositionEnum,
  cervixFirmnessEnum,
  cervixOpeningEnum,
  homeTestResultEnum,
  cycleTrackingGoalEnum,
  cycleDayLogInputSchema,
  cycleDayLogPatchSchema,
  cycleDayLogQuerySchema,
  cycleBulkSchema,
  cyclePeriodSchema,
  cyclePrefsSchema,
} from "@/lib/validations/cycle";
import {
  dataEnvelope,
  errorEnvelope,
  recordRefusal,
  stdResponses,
} from "./shared";

// ── Cycle tracking (v1.15.0) ─────────────────────────────────────────
// The `/api/cycle/*` capture / calendar / history / settings surface +
// the cycle-prefs PATCH. Request bodies come from the Zod validation
// module so the spec stays single-source; response DTOs are declared
// here mirroring `src/lib/cycle/dto.ts`. Every `/api/cycle/*` route also
// 403s `{ errorCode:"cycle.disabled" }` when the feature gate is off.

const predictionMethodEnumOpenapi = z
  .enum(["CALENDAR", "SYMPTOTHERMAL", "TEMPERATURE_TREND", "BLENDED"])
  .meta({ id: "CyclePredictionMethod" });

const cyclePhaseEnumOpenapi = z
  .enum(["MENSTRUAL", "FOLLICULAR", "OVULATORY", "LUTEAL"])
  .meta({ id: "CyclePhase" });

flowLevelEnum.meta({
  id: "FlowLevel",
  description: "Menstrual-flow intensity.",
});
ovulationTestEnum.meta({
  id: "OvulationTest",
  description: "Ovulation predictor-kit (OPK) reading.",
});
cervicalMucusEnum.meta({
  id: "CervicalMucus",
  description: "Cervical-mucus quality.",
});
homeTestResultEnum.meta({
  id: "HomeTestResult",
  description: "At-home test result (pregnancy / progesterone).",
});
cycleTrackingGoalEnum.meta({
  id: "CycleTrackingGoal",
  description: "Drives cycle copy + fertile-window gating.",
});

cycleDayLogInputSchema.meta({
  id: "CycleDayLogInput",
  description:
    "One day's cycle capture. `note` is encrypted at rest; every other field is queryable plaintext. UPSERT key: `(userId, source, externalId)` when externalId present, else `(userId, date)`. Shared by the single POST, the bulk drain, and the period shortcut.",
});

cycleBulkSchema.meta({
  id: "CycleDayLogBulkRequest",
  description:
    "Outbox / HealthKit drain. Up to 500 entries per call; wrapped in `withIdempotency`; rate-limited 60/min. Each entry upserts per the day-log key.",
});

cyclePeriodSchema.meta({
  id: "CyclePeriodRequest",
  description:
    "One-tap period boundary. `start` opens a new cycle (closing the prior), `end` stamps the current cycle's periodEndDate; both write a boundary day-log.",
});

cyclePrefsSchema.meta({
  id: "CyclePrefsRequest",
  description:
    "Partial cycle-preferences deep-merge. `enabled` flips the feature gate (`cycleTrackingEnabled`). Omitted fields are left untouched.",
});

cycleDayLogPatchSchema.meta({
  id: "CycleDayLogPatchRequest",
  description:
    "Partial day-log edit. Every field optional; `note` re-encrypts (explicit null clears it). `date` / `source` / `externalId` are immutable on update.",
});

const cycleSymptomDto = z.object({
  key: z.string(),
  severity: z.number().int().min(1).max(4).nullable(),
});

const cycleDayLogDto = z
  .object({
    id: z.string(),
    date: z.string(),
    cycleId: z.string().nullable(),
    flow: flowLevelEnum.nullable(),
    intermenstrualBleeding: z.boolean(),
    basalBodyTempC: z.number().nullable(),
    temperatureExcluded: z.boolean(),
    ovulationTest: ovulationTestEnum.nullable(),
    cervicalMucus: cervicalMucusEnum.nullable(),
    cervixPosition: cervixPositionEnum.nullable(),
    cervixFirmness: cervixFirmnessEnum.nullable(),
    cervixOpening: cervixOpeningEnum.nullable(),
    sexualActivity: z.boolean(),
    protectedSex: z.boolean().nullable(),
    pregnancyTest: homeTestResultEnum.nullable(),
    progesteroneTest: homeTestResultEnum.nullable(),
    contraceptive: z.string().nullable(),
    symptoms: z.array(cycleSymptomDto),
    note: z.string().nullable(),
    source: z.string(),
    externalId: z.string().nullable(),
    syncVersion: z.number().int(),
    updatedAt: z.iso.datetime({ offset: true }),
    deletedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({
    id: "CycleDayLogDTO",
    description:
      "The canonical day-log row iOS mirrors. `note` is decrypted on read. Soft-deleted rows ride `/api/sync/changes` as tombstones.",
  });

const menstrualCycleDto = z
  .object({
    id: z.string(),
    startDate: z.string(),
    endDate: z.string().nullable(),
    periodEndDate: z.string().nullable(),
    lengthDays: z.number().int().nullable(),
    ovulationDate: z.string().nullable(),
    ovulationConfirmed: z.boolean(),
    isPredicted: z.boolean(),
    syncVersion: z.number().int(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "MenstrualCycleDTO",
    description: "One menstrual cycle (observed or forward-predicted).",
  });

const cyclePredictionDto = z
  .object({
    method: predictionMethodEnumOpenapi,
    nextPeriodStart: z.string(),
    nextPeriodStartLow: z.string(),
    nextPeriodStartHigh: z.string(),
    fertileWindowStart: z.string().nullable(),
    fertileWindowEnd: z.string().nullable(),
    predictedOvulation: z.string().nullable(),
    ovulationConfirmed: z.boolean(),
    confidence: z.number(),
    cyclesObserved: z.number().int(),
    stillLearning: z.boolean(),
    disclaimer: z.string(),
  })
  .meta({
    id: "CyclePredictionDTO",
    description:
      "The materialised forecast. Fertile-window fields (and predictedOvulation/ovulationConfirmed) are server-suppressed (null/false) unless the goal is TRYING_TO_CONCEIVE or AVOID_PREGNANCY.",
  });

const cycleCalendarDayDto = z.object({
  date: z.string(),
  phase: cyclePhaseEnumOpenapi.nullable(),
  isPredictedPeriod: z.boolean(),
  isFertileWindow: z.boolean(),
  isPredictedOvulation: z.boolean(),
  isPeriodLogged: z.boolean(),
  isCycleStart: z.boolean().meta({
    description:
      "Whether a logged cycle opens on this day. Deleting this day's log removes that cycle start with it.",
  }),
  flow: flowLevelEnum.nullable(),
  hasSymptoms: z.boolean(),
  confidence: z.number(),
  // v1.15.0 — logged basal-body-temperature + fertility-sign markers, surfaced
  // so the web BBT chart renders from the calendar read (the values are already
  // loaded server-side for the symptothermal layer; no extra query).
  basalBodyTempC: z.number().nullable(),
  temperatureExcluded: z.boolean(),
  ovulationTest: ovulationTestEnum.nullable(),
  cervicalMucus: cervicalMucusEnum.nullable(),
  cervixPosition: cervixPositionEnum.nullable(),
  cervixFirmness: cervixFirmnessEnum.nullable(),
  cervixOpening: cervixOpeningEnum.nullable(),
});

const cycleVerdictDto = z
  .object({
    state: z.enum(["IN_CYCLE", "OVERDUE", "INSUFFICIENT_DATA"]),
    dayOfCycle: z.number().int().nullable().meta({
      description:
        "1-based day of the current cycle. Null in OVERDUE and INSUFFICIENT_DATA — beyond the typical length plus the server's grace window the count is no longer an observed fact.",
    }),
    cycleLength: z.number().int().nullable().meta({
      description:
        "Days the ring represents: the observed labelled run, or the profile-derived idealized cycle for a low-data tracker.",
    }),
    phase: cyclePhaseEnumOpenapi.nullable(),
    spans: z.array(
      z.object({ phase: cyclePhaseEnumOpenapi, fraction: z.number() }),
    ),
    cycleStartDate: z.string().nullable().meta({
      description:
        "First day of the current cycle (YYYY-MM-DD). Still set while OVERDUE — the last logged period start remains a fact once the count stops.",
    }),
    overdueDays: z.number().int().nullable().meta({
      description:
        "How many days past the profile's typical cycle length the open cycle has run. Set only in OVERDUE.",
    }),
    daysUntilNext: z.number().int().nullable().meta({
      description:
        "Days from today to the predicted next period start. Null when no prediction ran and null once that start is in the past.",
    }),
    fertileWindow: z.object({
      start: z.string().nullable(),
      end: z.string().nullable(),
      active: z.boolean(),
    }),
  })
  .meta({
    id: "CycleVerdictDTO",
    description:
      "The resolved cycle verdict for the user's own timezone day. Render these values; do not recompute them. The grace window that decides OVERDUE is deliberately not published — read `state` and `overdueDays`.",
  });

const cycleProfileDto = z
  .object({
    goal: cycleTrackingGoalEnum,
    cycleTrackingEnabled: z.boolean(),
    secondarySymptom: secondarySymptomEnum,
    rawChartMode: z.boolean(),
    predictionEnabled: z.boolean(),
    discreetNotifications: z.boolean(),
    sensitiveCategoryEncryption: z.boolean(),
    typicalCycleLength: z.number().int().nullable(),
    typicalPeriodLength: z.number().int().nullable(),
    lutealPhaseLength: z.number().int().nullable(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "CycleProfileDTO",
    description: "The full per-user cycle settings row.",
  });

const cycleCalendarResponse = z.object({
  profile: z.object({
    goal: cycleTrackingGoalEnum,
    rawChartMode: z.boolean(),
    predictionEnabled: z.boolean(),
    cyclesObserved: z.number().int(),
  }),
  prediction: cyclePredictionDto.nullable(),
  // The resolved verdict — required, never optional. An optional verdict is a
  // plausible default that invites a client to fall back to deriving its own,
  // which is the defect this field exists to remove.
  verdict: cycleVerdictDto,
  // Cold-start gate (mirrors `prediction.stillLearning`): true while < 3 cycles
  // are observed. When set, the `days` grid carries no fertile window, no
  // predicted-ovulation dot, and no phase band (those would rest on a
  // population prior) — the client shows a calm "learning your cycle" state.
  // Additive + back-compatible.
  stillLearning: z.boolean(),
  days: z.array(cycleCalendarDayDto),
  meta: z.object({ generatedAt: z.iso.datetime({ offset: true }) }),
});

const cycleHistoryResponse = z.object({
  cycles: z.array(menstrualCycleDto),
  stats: z.object({
    avgLengthDays: z.number().int().nullable(),
    lengthVariabilityDays: z.number().nullable(),
    avgPeriodLengthDays: z.number().int().nullable(),
    regularity: z.enum(["REGULAR", "IRREGULAR", "LEARNING"]),
  }),
});

const cyclePeriodResponse = z.object({
  cycle: menstrualCycleDto.nullable(),
  dayLog: cycleDayLogDto.nullable(),
});

const cyclePhaseCrosstabRow = z
  .object({
    metricKey: z.enum([
      "restingHeartRate",
      "heartRateVariability",
      "sleepDuration",
      "steps",
      "weight",
      "basalBodyTemp",
      "wristTemperature",
      "skinTemperature",
      "bloodGlucose",
      "mood",
    ]),
    display: z.enum([
      "hours",
      "steps",
      "bpm",
      "ms",
      "kg",
      "celsius",
      "glucose",
      "mood",
    ]),
    lutealDays: z.number().int(),
    follicularDays: z.number().int(),
    lutealAvg: z.number(),
    follicularAvg: z.number(),
    delta: z.number(),
    pValue: z.number(),
    qValue: z.number(),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .meta({
    id: "CyclePhaseCrosstabRow",
    description:
      "One FDR-surviving luteal-vs-follicular contrast for an outcome metric. `delta = lutealAvg − follicularAvg`. Observational, never causal.",
  });

const cyclePhaseLaggedPair = z
  .object({
    behaviour: z.string(),
    outcome: z.string(),
    n: z.number().int(),
    r: z.number(),
    pValue: z.number(),
    qValue: z.number(),
    interpretation: z.string(),
    lagDays: z.number().int(),
  })
  .meta({
    id: "CyclePhaseLaggedPair",
    description:
      "One FDR-surviving lagged-Pearson pair from the continuous CYCLE_PHASE ordinal × outcome matrix (mechanism B). Descriptive, never causal.",
  });

const cyclePhaseEnumForCount = z.enum([
  "MENSTRUAL",
  "FOLLICULAR",
  "OVULATORY",
  "LUTEAL",
]);

const cycleSymptomPhaseRow = z
  .object({
    symptomKey: z.string(),
    counts: z.object({
      MENSTRUAL: z.number().int(),
      FOLLICULAR: z.number().int(),
      OVULATORY: z.number().int(),
      LUTEAL: z.number().int(),
    }),
    total: z.number().int(),
    topPhase: cyclePhaseEnumForCount,
    topShare: z.number(),
  })
  .meta({
    id: "CycleSymptomPhaseRow",
    description:
      "Where a logged symptom clusters across the cycle phases. Surfaced only once logged on ≥3 phase-labelled days. Observational, never causal.",
  });

const cycleInsightsResponse = z.object({
  rows: z.array(cyclePhaseCrosstabRow),
  headline: cyclePhaseCrosstabRow.nullable(),
  lagged: z.object({
    discovered: z.array(cyclePhaseLaggedPair),
    pairsTested: z.number().int(),
    fdrQ: z.number(),
    minPairs: z.number().int(),
  }),
  symptomPatterns: z.array(cycleSymptomPhaseRow),
  contrast: z.object({
    high: z.literal("LUTEAL"),
    low: z.literal("FOLLICULAR"),
  }),
  windowDays: z.number().int(),
  cyclesObserved: z.number().int(),
});

const cycleBulkEntryResult = z.object({
  index: z.number().int(),
  status: z.enum(["inserted", "duplicate", "updated", "skipped"]),
  id: z.string().optional(),
  externalId: z.string().optional(),
  reason: z.string().optional(),
});

const cycleBulkResponse = z.object({
  processed: z.number().int(),
  inserted: z.number().int(),
  updated: z.number().int(),
  duplicates: z.number().int(),
  skipped: z.number().int(),
  entries: z.array(cycleBulkEntryResult),
});

// A reusable 403 the cycle routes carry (the feature gate).
const CYCLE_DISABLED_DESCRIPTION =
  "Cycle tracking is not enabled for this account (errorCode `cycle.disabled`). Resolved against the RECORD being read, not the caller: a delegate inside somebody else's record sees the owner's setting.";

const cycleDisabledResponse = {
  "403": {
    description: CYCLE_DISABLED_DESCRIPTION,
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

/**
 * The same gate on a delegable route, sharing its status with the sharing
 * refusal. One 403 per operation is all OpenAPI allows, so the two reasons
 * arrive in one description rather than one of them going unpublished.
 */
const cycleDisabledOnADelegableRoute = recordRefusal(
  CYCLE_DISABLED_DESCRIPTION,
);

export const cyclePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/cycle/day-logs": {
    get: {
      tags: ["Cycle"],
      summary: "Read a single day's cycle day-log (v1.15.0)",
      description:
        "Returns the full `CycleDayLogDTO` for the tz-anchored `date`, or `null` when nothing is logged that day. Lets a client pre-fill an edit sheet. Gated; owner-scoped; soft-deleted rows excluded.",
      requestParams: { query: cycleDayLogQuerySchema },
      responses: {
        "200": {
          description: "The day-log for that date, or null.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                cycleDayLogDto.nullable(),
                "CycleDayLogReadEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
    post: {
      tags: ["Cycle"],
      summary: "Capture a single cycle day-log (v1.15.0)",
      description:
        "Upserts on `(userId, source, externalId)` when externalId present, else `(userId, date)`. `note` encrypts at rest. 201 on insert, 200 on update. Gated: `cycle.disabled` 403 when the feature is off.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: cycleDayLogInputSchema } },
      },
      responses: {
        "200": {
          description: "Existing day-log updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleDayLogDto, "CycleDayLogEnvelope"),
            },
          },
        },
        "201": {
          description: "New day-log created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                cycleDayLogDto,
                "CycleDayLogCreatedEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/day-logs/{id}": {
    patch: {
      tags: ["Cycle"],
      summary: "Edit a single cycle day-log (v1.15.0)",
      description:
        "Partial edit; an omitted field is left untouched. Owner-scoped (a cross-user id 404s). Gated.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: cycleDayLogPatchSchema } },
      },
      responses: {
        "200": {
          description: "Day-log updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleDayLogDto, "CycleDayLogPatchEnvelope"),
            },
          },
        },
        "404": {
          description: "Day-log not found / not owned.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Cycle"],
      summary: "Soft-delete a cycle day-log (v1.15.0)",
      description:
        "Sets `deletedAt` + bumps `syncVersion`; surfaces as a tombstone on the next `/api/sync/changes` page. 204. Idempotent.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "204": { description: "Soft-deleted (no body)." },
        "404": {
          description: "Day-log not found / not owned.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/day-logs/bulk": {
    post: {
      tags: ["Cycle"],
      summary: "Bulk drain cycle day-logs (Outbox / HealthKit) (v1.15.0)",
      description:
        "Up to 500 entries; `withIdempotency`; rate-limited `cycle:day-logs:bulk:<userId>` 60/min. Per-entry status: inserted | duplicate | updated | skipped. Always 200.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: cycleBulkSchema } },
      },
      responses: {
        "200": {
          description: "Batch processed (per-entry results).",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleBulkResponse, "CycleBulkEnvelope"),
            },
          },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/period": {
    post: {
      tags: ["Cycle"],
      summary: "Period-boundary shortcut (v1.15.0)",
      description:
        "One-tap started/ended period. `start` opens a new cycle (closing the prior); `end` stamps periodEndDate. Writes the boundary day-log. Gated.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: cyclePeriodSchema } },
      },
      responses: {
        "200": {
          description: "Cycle + boundary day-log.",
          content: {
            "application/json": {
              schema: dataEnvelope(cyclePeriodResponse, "CyclePeriodEnvelope"),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/calendar": {
    get: {
      tags: ["Cycle"],
      summary: "Predicted cycle calendar (v1.15.0)",
      description:
        "Runs the deterministic engine to build `{ profile, prediction, days }`. Fertile-window fields are server-suppressed unless goal is TRYING_TO_CONCEIVE. Default range: today − 90d … +180d. Gated.",
      requestParams: {
        query: z.object({
          from: z.string().optional(),
          to: z.string().optional(),
        }),
      },
      responses: {
        "200": {
          description: "Calendar grid + forecast.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                cycleCalendarResponse,
                "CycleCalendarEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/cycles": {
    get: {
      tags: ["Cycle"],
      summary: "Cycle history + stats (v1.15.0)",
      description:
        "Most-recent cycles (newest first) + `{ avgLengthDays, lengthVariabilityDays (MAD), avgPeriodLengthDays, regularity }`. `limit` default 24. Gated.",
      requestParams: {
        query: z.object({
          limit: z.coerce.number().int().min(1).max(60).optional(),
        }),
      },
      responses: {
        "200": {
          description: "Cycle history.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                cycleHistoryResponse,
                "CycleHistoryEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/insights": {
    get: {
      tags: ["Cycle"],
      summary: "Cycle-phase correlation insights (v1.15.0)",
      description:
        "FDR-guarded luteal-vs-follicular phase contrast per outcome metric (RHR / HRV / sleep / steps / weight / temperatures), plus the single headline finding (resting-heart-rate-by-phase, falling back to HRV). The same Welch t-test + Benjamini-Hochberg machinery the mood-factor crosstab runs; only rows with p < 0.05 AND q ≤ 0.10 surface. Strictly gender-gated — phase never appears on the general `/api/insights/correlations` route. Observational only, never causal. Gated: `cycle.disabled` 403 when the feature is off.",
      responses: {
        "200": {
          description: "Phase-correlation rows + headline.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                cycleInsightsResponse,
                "CycleInsightsEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/cycles/{id}": {
    delete: {
      tags: ["Cycle"],
      summary: "Soft-delete a menstrual cycle (v1.15.0)",
      description:
        "Sets `deletedAt` + bumps `syncVersion`; tombstones on the next sync page. 204. Idempotent.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "204": { description: "Soft-deleted (no body)." },
        "404": {
          description: "Cycle not found / not owned.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/all": {
    delete: {
      tags: ["Cycle"],
      summary: "Hard-purge all cycle data (v1.15.0)",
      description:
        "One-click privacy purge: HARD-deletes every cycle day-log (+ symptom links by cascade), menstrual cycle, prediction, the cycle audit trail, and the cycle reminder rows in the push-attempts ledger — no dated reproductive trace survives. The CycleProfile row is left in place. Gated + owner-scoped + audited.",
      responses: {
        "200": {
          description: "Purge counts.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  purged: z.boolean(),
                  dayLogs: z.number().int(),
                  predictions: z.number().int(),
                  cycles: z.number().int(),
                  auditRows: z.number().int(),
                  pushRows: z.number().int(),
                }),
                "CyclePurgeEnvelope",
              ),
            },
          },
        },
        ...cycleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/cycle/profile": {
    get: {
      tags: ["Cycle"],
      summary: "Read the full cycle profile (v1.15.0)",
      description: "Returns the resolved CycleProfileDTO. Gated.",
      responses: {
        "200": {
          description: "Cycle profile.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleProfileDto, "CycleProfileEnvelope"),
            },
          },
        },
        ...cycleDisabledOnADelegableRoute,
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/cycle-prefs": {
    get: {
      tags: ["Cycle"],
      summary: "Read cycle preferences (v1.15.0)",
      description:
        "Returns the resolved CycleProfileDTO. NOT gated — this is the surface that flips the gate.",
      responses: {
        "200": {
          description: "Cycle preferences.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleProfileDto, "CyclePrefsGetEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Cycle"],
      summary: "Update cycle preferences (v1.15.0)",
      description:
        "Deep-merges the supplied fields. `enabled` flips `cycleTrackingEnabled`. Returns the merged CycleProfileDTO. NOT gated.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: cyclePrefsSchema } },
      },
      responses: {
        "200": {
          description: "Merged cycle preferences.",
          content: {
            "application/json": {
              schema: dataEnvelope(cycleProfileDto, "CyclePrefsPatchEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
