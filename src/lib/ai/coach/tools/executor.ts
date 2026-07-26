/**
 * v1.20.0 (F1) — Coach retrieval tool executor.
 *
 * Dispatches a single tool call from the model: validates the raw JSON
 * arguments against the tool's Zod schema, runs the existing
 * server-authoritative snapshot builder scoped to just the requested domain,
 * and slices the matching section(s) out of the structured result.
 *
 * GROUNDING CONTRACTS (the hallucination audit hammers these):
 *   - Every tool returns a structured `{ present: boolean }`. When the domain
 *     carries no data — or the user opted out of the owning module — the result
 *     is `{ present: false, reason }`. It NEVER throws and NEVER returns an
 *     ambiguous `[]`, so the model can always tell "no data" from "data".
 *   - An empty WINDOW read is never reported as absence on its own. Every
 *     `present: false` that comes from a missing snapshot section routes through
 *     `resolveEmptyRead`, which probes whether the record holds rows outside the
 *     window and returns `outside_window` (with the range + a bounded aggregate)
 *     rather than `no_data`. One reason code for "never recorded" and "recorded,
 *     outside the window I searched" is what made the Coach deny data the app
 *     was displaying on the next screen.
 *   - Module / cycle gates are enforced AT THE BUILDER (`buildCoachSnapshot`
 *     applies `MODULE_EXCLUDED_SOURCES` + the cycle gate before any row is
 *     read), so an opted-out domain is structurally unfetchable here — the
 *     section simply never appears and the executor reports `present: false`.
 *   - `userId` is the session-narrowed id passed by the route, never a tool
 *     argument. Tools are read-only (snapshot reads only), so there is no
 *     mutation or egress surface.
 *
 * The builder result is memoised by the 60s snapshot LRU keyed on
 * `(userId, window, sources)`.
 *
 * v1.21.0 (D5-1) — ONE snapshot per turn. The route hands every tool the SAME
 * `sharedScope` it built the DATA INVENTORY against (the full source set + the
 * conversation window). A full-source build already contains every section, so
 * each tool reads under that shared scope key and slices its own section out —
 * landing the 60s LRU hit the inventory primed rather than rebuilding a
 * distinct single-source snapshot per tool (the D5-1 N-builds-per-turn cost).
 * A tool that overrides the window to something OTHER than the shared window
 * still gets a correct, distinct build (the rare case); the common path
 * collapses to one build.
 */
import { z } from "zod/v4";

import { annotate } from "@/lib/logging/context";
import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import type { CoachScope, CoachScopeWindow } from "@/lib/ai/coach/types";
import {
  getMetricSeriesArgsSchema,
  getGlucosePanelArgsSchema,
  getSleepArgsSchema,
  getMedicationComplianceArgsSchema,
  getLabsArgsSchema,
  getIllnessRecoveryArgsSchema,
  getWorkoutsArgsSchema,
  getCycleArgsSchema,
  getCorrelationsArgsSchema,
  isCoachToolName,
  type CoachToolName,
} from "./definitions";
import {
  COACH_SOURCE_SNAPSHOT_KEY,
  METRIC_SERIES_EXCLUDED_SOURCES,
} from "./source-keys";
import { readCoachCorrelations } from "./correlations-read";
import {
  resolveEmptyRead,
  subjectForTool,
  type CoachAvailabilitySubject,
  type CoachDomainAvailability,
} from "./availability";
import { buildIllnessScores } from "@/lib/ai/coach/illness-snapshot";

/** A read-only structured tool result. Serialised to a `role:"tool"` turn. */
export interface CoachToolResult {
  present: boolean;
  /** Short machine reason on a `present: false` result (no PII). */
  reason?: string;
  /** The domain payload on a `present: true` result (the snapshot section). */
  data?: unknown;
  /**
   * Optional citation-coupled reference grounding for the fetched metric —
   * published population bands + the user's placement, general guidance only.
   */
  grounding?: string;
  /** The window an empty read searched, so a miss describes its own scope. */
  searchedWindow?: string;
  /**
   * On a `present: false` result whose reason is `outside_window` /
   * `unavailable_in_scope`: what the record holds for this domain over its whole
   * history — count, date range, and a bounded per-series aggregate. These are
   * server-computed figures the model MAY cite; they ride the authoritative set
   * for the prose number-verifier exactly like a present result's payload.
   */
  available?: CoachDomainAvailability;
}

/** What the route persists onto provenance: which tools ran, did data exist. */
export interface CoachToolTrace {
  name: string;
  present: boolean;
}

function pickSection(
  sections: Record<string, unknown>,
  key: string,
): unknown | undefined {
  const value = sections[key];
  if (value === undefined || value === null) return undefined;
  return value;
}

/**
 * Resolve the scope a tool reads its snapshot under.
 *
 * v1.21.0 (D5-1) — when the route handed us a `sharedScope` (the full-source
 * inventory build for this turn) AND the tool's effective window matches the
 * shared window, read under the SHARED scope key so the per-tool read lands the
 * 60s LRU hit the inventory already primed (the section it needs is present in
 * the full-source build). Otherwise — no shared scope, or a window override —
 * fall back to the tight per-source scope (a correct, distinct build).
 *
 * The window default chain is unchanged: `args.window` wins, else the
 * conversation's `fallbackWindow`, else the builder default.
 */
function scopeFor(
  sources: CoachScope["sources"],
  window: CoachScopeWindow | undefined,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
): CoachScope {
  const effectiveWindow = window ?? fallbackWindow;
  if (sharedScope && sharedScope.window === effectiveWindow) {
    // Same window as the inventory's full-source build → reuse its cache entry.
    return sharedScope;
  }
  return {
    sources,
    window: effectiveWindow,
  };
}

/**
 * Execute one tool call. `rawArguments` is the model's raw JSON-string
 * arguments (parsed + validated here, never trusted blindly). Returns a
 * grounded `CoachToolResult` — a validation failure or unknown tool resolves
 * to `{ present: false }`, never a throw, so a single bad call can't break the
 * turn.
 */
export async function executeCoachTool(args: {
  userId: string;
  name: string;
  rawArguments: string;
  /** The conversation's effective window, used when a call omits `window`. */
  fallbackWindow?: CoachScopeWindow;
  /**
   * v1.21.0 (D5-1) — the turn's shared full-source snapshot scope (the same one
   * the DATA INVENTORY was built against). When present and the tool's window
   * matches, the tool reads under this scope key so it lands the inventory's
   * already-built cache entry instead of rebuilding a single-source snapshot.
   */
  sharedScope?: CoachScope;
}): Promise<CoachToolResult> {
  const { userId, name, rawArguments, fallbackWindow, sharedScope } = args;

  if (!isCoachToolName(name)) {
    annotate({
      action: { name: "coach.tool.unknown" },
      meta: { tool: name.slice(0, 48) },
    });
    return { present: false, reason: "unknown_tool" };
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
  } catch {
    annotate({
      action: { name: "coach.tool.bad_arguments" },
      meta: { tool: name, reason: "invalid_json" },
    });
    return { present: false, reason: "invalid_arguments" };
  }

  try {
    const result = await dispatch(
      name,
      userId,
      parsedArgs,
      fallbackWindow,
      sharedScope,
    );
    annotate({
      action: { name: "coach.tool.executed" },
      meta: { tool: name, present: result.present },
    });
    return result;
  } catch (err) {
    // A read failure must degrade to a grounded "no data" rather than break
    // the loop — the model then says it could not retrieve the metric.
    annotate({
      action: { name: "coach.tool.error" },
      meta: {
        tool: name,
        reason: err instanceof Error ? err.name : "unknown",
      },
    });
    return { present: false, reason: "retrieval_failed" };
  }
}

async function dispatch(
  name: CoachToolName,
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
): Promise<CoachToolResult> {
  switch (name) {
    case "get_metric_series":
      return getMetricSeries(userId, rawArgs, fallbackWindow, sharedScope);
    case "get_glucose_panel":
      return getGlucosePanel(userId, rawArgs, fallbackWindow, sharedScope);
    case "get_sleep":
      return getSleep(userId, rawArgs, fallbackWindow, sharedScope);
    case "get_medication_compliance":
      return getMedicationCompliance(
        userId,
        rawArgs,
        fallbackWindow,
        sharedScope,
      );
    case "get_labs":
      return getLabs(userId, rawArgs, fallbackWindow, sharedScope);
    case "get_illness_recovery":
      return getIllnessRecovery(userId, fallbackWindow, sharedScope);
    case "get_workouts":
      return getWorkouts(userId, rawArgs, fallbackWindow, sharedScope);
    case "get_cycle":
      return getCycle(userId, rawArgs, sharedScope);
    case "get_correlations":
      return getCorrelations(userId, rawArgs);
  }
}

function badArgs(name: string, error: z.ZodError): CoachToolResult {
  annotate({
    action: { name: "coach.tool.bad_arguments" },
    meta: { tool: name, reason: "schema", issues: error.issues.length },
  });
  return { present: false, reason: "invalid_arguments" };
}

/**
 * The one exit for "the window read produced no section". Never returns a bare
 * `no_data` without the probe having confirmed the record is empty — see
 * `availability.ts` for the four states it can resolve to.
 */
function emptyRead(
  userId: string,
  domain: string,
  subject: CoachAvailabilitySubject | null,
  searchedWindow: CoachScopeWindow | undefined,
): Promise<CoachToolResult> {
  return resolveEmptyRead({ userId, domain, subject, searchedWindow });
}

async function getMetricSeries(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
): Promise<CoachToolResult> {
  const parsed = getMetricSeriesArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_metric_series", parsed.error);
  const { metric, window } = parsed.data;

  // Glucose / workouts / compliance have dedicated tools (or are deferred);
  // refuse to answer them here so the model is pointed at the right tool
  // rather than getting a fabricated-shape miss.
  if (METRIC_SERIES_EXCLUDED_SOURCES.has(metric)) {
    return {
      present: false,
      reason:
        metric === "glucose"
          ? "use_get_glucose_panel"
          : metric === "compliance"
            ? "use_get_medication_compliance"
            : "unsupported_metric",
    };
  }

  const sectionKey = COACH_SOURCE_SNAPSHOT_KEY[metric];
  if (!sectionKey) {
    return { present: false, reason: "unsupported_metric" };
  }

  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor([metric], window, fallbackWindow, sharedScope),
  );
  const section = pickSection(snapshot.sections, sectionKey);
  if (section === undefined) {
    return emptyRead(
      userId,
      metric,
      subjectForTool("get_metric_series", metric),
      window ?? fallbackWindow,
    );
  }
  return {
    present: true,
    data: { metric, section },
    grounding: snapshot.referenceGrounding ?? undefined,
  };
}

async function getGlucosePanel(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
): Promise<CoachToolResult> {
  const parsed = getGlucosePanelArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_glucose_panel", parsed.error);
  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor(["glucose"], parsed.data.window, fallbackWindow, sharedScope),
  );
  const section = pickSection(snapshot.sections, "glucose");
  if (section === undefined) {
    return emptyRead(
      userId,
      "glucose",
      subjectForTool("get_glucose_panel"),
      parsed.data.window ?? fallbackWindow,
    );
  }
  return {
    present: true,
    data: section,
    grounding: snapshot.referenceGrounding ?? undefined,
  };
}

async function getSleep(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
): Promise<CoachToolResult> {
  const parsed = getSleepArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_sleep", parsed.error);
  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor(["sleep"], parsed.data.window, fallbackWindow, sharedScope),
  );
  const nights = pickSection(snapshot.sections, "sleep");
  const rhythm = pickSection(snapshot.sections, "sleepRhythm");
  if (nights === undefined && rhythm === undefined) {
    return emptyRead(
      userId,
      "sleep",
      subjectForTool("get_sleep"),
      parsed.data.window ?? fallbackWindow,
    );
  }
  return {
    present: true,
    data: {
      ...(nights !== undefined ? { nights } : {}),
      ...(rhythm !== undefined ? { rhythm } : {}),
    },
    grounding: snapshot.referenceGrounding ?? undefined,
  };
}

async function getMedicationCompliance(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
): Promise<CoachToolResult> {
  const parsed = getMedicationComplianceArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return badArgs("get_medication_compliance", parsed.error);
  }
  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor(["compliance"], parsed.data.window, fallbackWindow, sharedScope),
  );
  const compliance = pickSection(snapshot.sections, "compliance");
  // GLP-1 context rides the `weeklyContext` block.
  const weeklyContext = pickSection(snapshot.sections, "weeklyContext") as
    { glp1?: unknown } | undefined;
  const glp1 = weeklyContext?.glp1;
  if (compliance === undefined && glp1 === undefined) {
    return emptyRead(
      userId,
      "compliance",
      subjectForTool("get_medication_compliance"),
      parsed.data.window ?? fallbackWindow,
    );
  }
  return {
    present: true,
    data: {
      ...(compliance !== undefined ? { compliance } : {}),
      ...(glp1 !== undefined ? { glp1 } : {}),
    },
  };
}

async function getLabs(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
): Promise<CoachToolResult> {
  const parsed = getLabsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_labs", parsed.error);
  // Labs ride the snapshot regardless of `sources` (attached unconditionally),
  // so a minimal scope still surfaces them.
  //
  // v1.21.0 (A5-F4) — the labs block itself is a "latest reading per biomarker
  // over the last 12 months" snapshot and is intentionally window-AGNOSTIC
  // (the read cutoff is fixed). We still thread the conversation's window onto
  // the scope so the snapshot's `scope` block reports the right horizon for the
  // turn; it does not move the labs read.
  //
  // v1.21.0 (D5-1) — prefer the turn's shared full-source scope so this read
  // lands the inventory's cache entry; fall back to a tight empty-source scope
  // (labs ride unconditionally) when no shared scope or a window mismatch.
  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor([], fallbackWindow, fallbackWindow, sharedScope),
  );
  const labs = pickSection(snapshot.sections, "labs") as
    { recent?: Array<{ name?: string; analyte?: string }> } | undefined;
  if (labs === undefined) {
    // The labs read is window-AGNOSTIC: a fixed trailing-12-month cutoff. So the
    // window it "searched" is a year regardless of the conversation's scope —
    // a panel from 2023 is outside it and must not read as "no labs on file".
    return emptyRead(userId, "labs", subjectForTool("get_labs"), "lastYear");
  }

  const analyte = parsed.data.analyte?.trim().toLowerCase();
  if (analyte && Array.isArray(labs.recent)) {
    const filtered = labs.recent.filter((entry) => {
      const haystack =
        `${entry.name ?? ""} ${entry.analyte ?? ""}`.toLowerCase();
      return haystack.includes(analyte);
    });
    if (filtered.length === 0) {
      return { present: false, reason: "analyte_not_found" };
    }
    return { present: true, data: { recent: filtered } };
  }
  return { present: true, data: labs };
}

async function getIllnessRecovery(
  userId: string,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
): Promise<CoachToolResult> {
  // Validate the (empty) args shape for consistency; an empty object always
  // passes.
  getIllnessRecoveryArgsSchema.parse({});
  // Recovery composites gate on the `recovery` module + the HRV/RHR/VO2max
  // sources; request them so the derived / dayStrain / trajectory blocks can
  // build when the module is on. Illness rides the snapshot unconditionally.
  //
  // v1.21.0 (A5-F4) — honour the conversation's window so the recovery/strain/
  // trajectory composites are computed over the horizon the caller asked for
  // rather than the builder default.
  //
  // v1.21.0 (D5-1) — prefer the turn's shared full-source scope (which already
  // carries hrv/resting_hr/vo2_max + illness + derived) so this read lands the
  // inventory's cache entry; the narrow scope is the window-mismatch fallback.
  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor(
      ["hrv", "resting_hr", "vo2_max"],
      fallbackWindow,
      fallbackWindow,
      sharedScope,
    ),
  );
  const illness = pickSection(snapshot.sections, "illness");
  const derived = pickSection(snapshot.sections, "derived");
  const dayStrain = pickSection(snapshot.sections, "dayStrain");
  const trajectory = pickSection(snapshot.sections, "trajectory");
  // v1.21.0 (NEW-B B-2) — the computed illness retrospective the card shows
  // (recovery-gap, gap-driver, nadir, pre-onset, red flags) for the most
  // relevant episode. Read-only, coverage-gated (null when the engine
  // withholds), and the SAME engine the card + the red-flag notifier run, so
  // the Coach restates the numbers the user sees rather than the composite.
  const illnessScores = await buildIllnessScores(userId);
  if (
    illness === undefined &&
    derived === undefined &&
    dayStrain === undefined &&
    trajectory === undefined &&
    illnessScores === null
  ) {
    // No row-backed subject: illness episodes + the recovery composites are
    // computed / module-gated, not a window slice of one table, so there is
    // nothing an availability probe could establish. Honest absence.
    return emptyRead(
      userId,
      "illness_recovery",
      subjectForTool("get_illness_recovery"),
      fallbackWindow,
    );
  }
  return {
    present: true,
    data: {
      ...(illness !== undefined ? { illness } : {}),
      ...(illnessScores !== null ? { illnessScores } : {}),
      ...(derived !== undefined ? { derived } : {}),
      ...(dayStrain !== undefined ? { dayStrain } : {}),
      ...(trajectory !== undefined ? { trajectory } : {}),
    },
  };
}

async function getWorkouts(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
): Promise<CoachToolResult> {
  const parsed = getWorkoutsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_workouts", parsed.error);
  // The workouts block builds when the `workouts` cluster is active AND the
  // user has workout rows in the window. Scope the read to that single source.
  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor(["workouts"], parsed.data.window, fallbackWindow, sharedScope),
  );
  const workouts = pickSection(snapshot.sections, "workouts");
  if (workouts === undefined) {
    return emptyRead(
      userId,
      "workouts",
      subjectForTool("get_workouts"),
      parsed.data.window ?? fallbackWindow,
    );
  }
  return { present: true, data: workouts };
}

async function getCycle(
  userId: string,
  rawArgs: unknown,
  sharedScope: CoachScope | undefined,
): Promise<CoachToolResult> {
  const parsed = getCycleArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_cycle", parsed.error);
  // The cycle block is gated INSIDE the builder by `isCycleAvailableForUser`
  // (the per-user toggle AND the operator switch), independent of `sources` —
  // so a minimal scope still surfaces it when the account tracks cycles, and a
  // non-cycle account structurally produces no block (→ present:false).
  //
  // v1.21.0 (D5-1) — prefer the turn's shared full-source scope so this read
  // lands the inventory's cache entry; the empty-source scope is the fallback
  // when no shared scope is threaded.
  const snapshot = await buildCoachSnapshot(
    userId,
    sharedScope ?? { sources: [] },
  );
  const cycle = pickSection(snapshot.sections, "cycle");
  if (cycle === undefined) {
    // No row-backed subject: the cycle block is gated by the per-user toggle
    // AND the operator switch inside the builder, so an absent block is a gate
    // verdict rather than a window artefact.
    return emptyRead(
      userId,
      "cycle",
      subjectForTool("get_cycle"),
      sharedScope?.window,
    );
  }
  return { present: true, data: cycle };
}

async function getCorrelations(
  userId: string,
  rawArgs: unknown,
): Promise<CoachToolResult> {
  const parsed = getCorrelationsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_correlations", parsed.error);
  // Reads the deterministic FDR discovery + coincident-deviation flag; returns
  // a clean `{ present: false }` when too little paired data exists.
  //
  // No availability probe here, and no window either: a discovered pattern is
  // not a slice of one table — it needs two channels paired over overlapping
  // days, and the reader already reports WHY nothing survived (its own reason
  // code). "No pattern survived the correction" is an honest absence of a
  // finding, not an absence of data, and nothing older would change it.
  const result = await readCoachCorrelations(userId);
  if (!result.present) {
    return { present: false, reason: result.reason ?? "no_pattern" };
  }
  return {
    present: true,
    data: {
      ...(result.drivers ? { drivers: result.drivers } : {}),
      ...(result.coincident ? { coincident: result.coincident } : {}),
      pairsTested: result.pairsTested,
      windowDays: result.windowDays,
    },
  };
}
