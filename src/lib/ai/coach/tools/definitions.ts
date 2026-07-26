/**
 * v1.20.0 (F1) — Coach retrieval tool catalogue.
 *
 * Replaces snapshot-stuffing with on-demand retrieval: the model is handed a
 * tiny DATA INVENTORY in the base context and pulls only the domains it needs
 * via these tools. Each tool is a THIN, READ-ONLY wrapper over the existing
 * server-authoritative snapshot builder (`buildCoachSnapshot`) — same numbers,
 * same module/cycle gates, same I/O. No tool ever accepts `userId` (it is
 * narrowed from the session in the executor), and every tool is read-only, so
 * there is no new mutation or egress surface.
 *
 * Tools ship as a closed catalogue:
 *   1. get_metric_series         — BP / weight / pulse + the ~38 additive series
 *   2. get_glucose_panel         — per-context daily means + the 30-day clinical panel
 *   3. get_sleep                 — per-night sleep + sleep-rhythm (debt + chronotype)
 *   4. get_medication_compliance — dose-weighted compliance + GLP-1
 *   5. get_labs                  — latest reading per biomarker (12 months)
 *   6. get_illness_recovery      — restMode + active/resolved illnesses + recovery composites
 *   7. get_workouts              — recent sessions + per-sport rollup (v1.21.0, C2-4)
 *   8. get_cycle                 — menstrual phase / prediction / correlation (v1.21.0, C2-1)
 *   9. get_correlations          — discovered FDR cross-metric drivers + the
 *                                  coincident-deviation flag (v1.21.0, C3)
 */
import { z } from "zod/v4";

import type { AiToolDef } from "@/lib/ai/types";
import {
  coachScopeSourceSchema,
  coachScopeWindowSchema,
} from "@/lib/ai/coach/types";

/** The closed set of tool names F1 ships. */
export const COACH_TOOL_NAMES = [
  "get_metric_series",
  "get_glucose_panel",
  "get_sleep",
  "get_medication_compliance",
  "get_labs",
  "get_illness_recovery",
  "get_workouts",
  "get_cycle",
  "get_correlations",
] as const;

export type CoachToolName = (typeof COACH_TOOL_NAMES)[number];

export function isCoachToolName(name: string): name is CoachToolName {
  return (COACH_TOOL_NAMES as readonly string[]).includes(name);
}

// ── Per-tool argument schemas ────────────────────────────────────────
// Closed enums + optional windows only — no free-text, no host, no id. The
// executor `safeParse`s the model's raw JSON arguments against these before it
// touches the snapshot builder, so a malformed / adversarial argument blob can
// never widen scope or reach an un-validated read.

export const getMetricSeriesArgsSchema = z
  .object({
    metric: coachScopeSourceSchema,
    window: coachScopeWindowSchema.optional(),
  })
  .strict();

export const getGlucosePanelArgsSchema = z
  .object({
    window: coachScopeWindowSchema.optional(),
  })
  .strict();

export const getSleepArgsSchema = z
  .object({
    window: coachScopeWindowSchema.optional(),
  })
  .strict();

export const getMedicationComplianceArgsSchema = z
  .object({
    window: coachScopeWindowSchema.optional(),
  })
  .strict();

export const getLabsArgsSchema = z
  .object({
    /** Optional single-analyte filter (free-text biomarker name). */
    analyte: z.string().min(1).max(80).optional(),
  })
  .strict();

export const getIllnessRecoveryArgsSchema = z.object({}).strict();

export const getWorkoutsArgsSchema = z
  .object({
    window: coachScopeWindowSchema.optional(),
  })
  .strict();

export const getCycleArgsSchema = z.object({}).strict();

export const getCorrelationsArgsSchema = z.object({}).strict();

/**
 * JSON-Schema parameter shapes handed to the provider. Kept hand-written
 * (rather than generated from Zod) so the wire description the model reads is
 * compact and stable — the byte-stable tool block keeps the cached prefix
 * intact across turns.
 */
const WINDOW_ENUM = [
  "last7days",
  "last30days",
  "last90days",
  "lastYear",
  "allTime",
];

/**
 * The tool definitions offered to the model. Descriptions are deliberately
 * terse and brand-free; they tell the model WHEN to reach for each tool and
 * that an absent domain returns `{ present: false }` rather than an error.
 */
export const COACH_TOOL_DEFS: AiToolDef[] = [
  {
    name: "get_metric_series",
    description:
      "Fetch the user's own time series for ONE metric: blood pressure (bp), weight, pulse, or any synced series (hrv, resting_hr, steps, sleep duration, body composition, gait, audio exposure, vo2_max, …). Returns an aggregate plus a recent-daily and weekly timeline. Call once per metric you need; call several in parallel for a multi-metric question. Returns { present: false } with a reason when nothing came back: no_data (never recorded), outside_window (recorded, but older than the window searched — the result carries the count, date range and aggregate, and the window to re-call with), unavailable_in_scope, or no_data_unconfirmed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["metric"],
      properties: {
        metric: {
          type: "string",
          enum: coachScopeSourceSchema.options,
          description: "The metric to fetch.",
        },
        window: {
          type: "string",
          enum: WINDOW_ENUM,
          description: "Analysis window. Defaults to the user's scope window.",
        },
      },
    },
  },
  {
    name: "get_glucose_panel",
    description:
      "Fetch the user's glucose data: per-context daily means plus the trailing-30-day clinical panel (time-in-range, GMI, CV%, estimated A1c). Returns { present: false } with a reason when nothing came back — no_data means no glucose was ever logged, outside_window means it was and lies older than the window searched (the result carries the count, date range and aggregate).",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        window: {
          type: "string",
          enum: WINDOW_ENUM,
          description:
            "Window for the per-context means. The clinical panel is always the fixed trailing 30 days.",
        },
      },
    },
  },
  {
    name: "get_sleep",
    description:
      "Fetch the user's sleep: per-night asleep + stage minutes plus the sleep-rhythm summary (sleep debt + chronotype). Returns { present: false } with a reason — no_data means no sleep was ever tracked, outside_window means it was and lies older than the window searched.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        window: {
          type: "string",
          enum: WINDOW_ENUM,
          description: "Analysis window. Defaults to the user's scope window.",
        },
      },
    },
  },
  {
    name: "get_medication_compliance",
    description:
      "Fetch the user's medication compliance: the dose-weighted adherence rate plus a recent timeline, and any GLP-1 titration context. Returns { present: false } with a reason — no_data means no doses were ever logged, outside_window means they were and lie older than the window searched.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        window: {
          type: "string",
          enum: WINDOW_ENUM,
          description: "Analysis window. Defaults to the user's scope window.",
        },
      },
    },
  },
  {
    name: "get_labs",
    description:
      "Fetch the user's most recent lab results — the latest reading per biomarker over the last 12 months, or one named analyte. Returns { present: false } with a reason — no_data means no labs are on file, outside_window means panels exist but are older than the twelve months this tool reads.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        analyte: {
          type: "string",
          description:
            "Optional single biomarker name to filter to (e.g. 'LDL').",
        },
      },
    },
  },
  {
    name: "get_illness_recovery",
    description:
      "Fetch the user's illness + recovery context: rest mode, active and recently-resolved illnesses, and the recovery / strain composites. Returns { present: false } when there is nothing to report.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
  },
  {
    name: "get_workouts",
    description:
      "Fetch the user's workouts: the most recent sessions (sport, duration, energy, distance, avg/max HR) plus a per-sport rollup over the window. Use for training-load and 'how were my runs / am I overtraining?' questions. Returns { present: false } with a reason — no_data means no workouts were ever tracked, outside_window means they were and lie older than the window searched.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        window: {
          type: "string",
          enum: WINDOW_ENUM,
          description: "Analysis window. Defaults to the user's scope window.",
        },
      },
    },
  },
  {
    name: "get_cycle",
    description:
      "Fetch the user's menstrual-cycle context: current phase + day-of-cycle, the next predicted event, and the headline phase-correlation finding. Descriptive only — never a contraception-grade or 'safe day' claim. Returns { present: false } when cycle tracking is off or there is no data.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
  },
  {
    name: "get_correlations",
    description:
      "Fetch the user's DISCOVERED cross-metric patterns: statistically-vetted (FDR-controlled) day-to-next-day driver pairs between behaviours (daylight, mood, glucose, blood pressure, steps) and outcomes (sleep, HRV, resting HR, weight, mood), each with direction, lag, sample size and a descriptive — never causal — note. Also reports the coincident-deviation flag (whether two or more vitals are outside their usual band today). Use when a metric is off and you want to state the observed linkage. Returns { present: false } when too little paired data exists for any pattern to survive.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
  },
];
