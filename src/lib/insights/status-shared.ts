/**
 * Shared helpers for the seven per-card status generators.
 *
 * Every `src/lib/insights/*-status.ts` generator carried byte-identical
 * copies of `round`, `normalizeSummaryText`, `normalizeLocale`, and (in
 * six of seven) `summarizeSeries`, plus an identical "parse the model's
 * `{summary}` envelope" block and an identical `prisma.auditLog.create`
 * persist block. This module is the single source of truth so a change
 * to the rounding precision, the chart-token scrub, or the cache-row
 * shape lands once rather than seven times.
 *
 * `SupportedLocale` is the full six-locale UI union. The status prompts
 * compose one of two reviewed instruction bodies (de / en) but name the
 * reader's own language in an explicit output directive, so the reader's
 * locale must survive the whole pipeline rather than being collapsed to a
 * binary on the way in. The
 * medication-compliance generator writes a richer cache `details` shape
 * (it carries a per-medication array), so it shares `round`,
 * `normalizeSummaryText`, `normalizeLocale`, and `parseSummaryFromContent`
 * but keeps its own `auditLog.create`.
 */
import { prisma } from "@/lib/db";
import { locales, type Locale } from "@/lib/i18n/config";
import { extractJsonObject } from "@/lib/ai/json-extract";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import {
  screenModelOutput,
  INSIGHTS_CONTRACTS,
  type OutboundReason,
} from "@/lib/ai/safety/outbound-screen";

/**
 * The locales the assessment pipeline carries end-to-end — all six the UI
 * ships. Aliased to the i18n `Locale` so adding a UI locale widens the
 * pipeline in one place rather than needing a second edit here.
 */
export type SupportedLocale = Locale;

const SUPPORTED_LOCALES: ReadonlySet<string> = new Set(locales);

/**
 * The presentation contract shared by assessment producers and consumers.
 *
 * `kind` is the only branch discriminator. In particular, provider
 * availability is metadata: it must never hide safe deterministic text.
 * Provider/error details deliberately do not belong in this envelope.
 */
export type AssessmentStatus =
  | {
      kind: "generated";
      text: string;
      hasProvider: true;
      updatedAt: string | null;
      retryable: false;
    }
  | {
      kind: "screened-fallback";
      text: string;
      hasProvider: boolean;
      updatedAt: null;
      retryable: true;
      reason: OutboundReason | "unparseable_output" | "ungrounded_output";
    }
  | {
      kind: "no-provider";
      text: null;
      hasProvider: false;
      updatedAt: null;
      retryable: false;
    }
  | {
      kind: "preparing";
      text: null;
      hasProvider: true;
      updatedAt: null;
      retryable: true;
    }
  | {
      kind: "revalidating";
      text: string;
      hasProvider: true;
      updatedAt: string | null;
      retryable: true;
    }
  | {
      kind: "timeout" | "error";
      text: null;
      hasProvider: true;
      updatedAt: null;
      retryable: true;
    }
  | {
      kind: "exhausted";
      text: null;
      hasProvider: true;
      updatedAt: null;
      retryable: false;
    };

/** Round to `digits` decimal places. */
export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Scrub chart tokens and collapse whitespace out of a model summary. */
export function normalizeSummaryText(value: string): string {
  return stripChartTokens(value).replace(/\s+/g, " ").trim();
}

/**
 * Validate an arbitrary locale string against the six the UI ships.
 *
 * A recognised locale passes through UNCHANGED — that is the whole point:
 * the former `value === "de" ? "de" : "en"` binary erased a French reader's
 * locale before any prompt saw it, so the output-language directive could
 * never fire. An unrecognised or missing value defaults to ENGLISH, never
 * German; a German default is the bug class this replaces.
 */
export function normalizeLocale(
  value: string | null | undefined,
): SupportedLocale {
  return typeof value === "string" && SUPPORTED_LOCALES.has(value)
    ? (value as SupportedLocale)
    : "en";
}

export interface SeriesSummary {
  points: number;
  start: number;
  end: number;
  delta: number;
  mean: number;
  min: number;
  max: number;
}

/**
 * Fold a value series into a single start/end/delta/mean/min/max
 * summary. Returns null for an empty series.
 *
 * v1.4.33 — fold sum/min/max into a single walk. The previous
 * `Math.min(...series.map(...))` / `Math.max(...series.map(...))`
 * spread tripped V8's ~125 000-arg ceiling on the bound /api/analytics
 * path; see `.planning/round-v1433-analytics-500-report.md` §"Carry-
 * over". These helpers are fed bounded windows today so the crash
 * never reached them, but the spread allocates a transient args array
 * on every call — the fold is both stack-safe and cheaper.
 */
export function summarizeSeries(
  series: Array<{ value: number }>,
): SeriesSummary | null {
  if (series.length === 0) return null;
  const first = series[0].value;
  const last = series[series.length - 1].value;
  let sum = 0;
  let minVal = series[0].value;
  let maxVal = series[0].value;
  for (const entry of series) {
    sum += entry.value;
    if (entry.value < minVal) minVal = entry.value;
    if (entry.value > maxVal) maxVal = entry.value;
  }
  return {
    points: series.length,
    start: round(first, 2),
    end: round(last, 2),
    delta: round(last - first, 2),
    mean: round(sum / series.length, 2),
    min: round(minVal, 2),
    max: round(maxVal, 2),
  };
}

/**
 * Strip a Markdown code fence and isolate the JSON object body.
 *
 * The Anthropic and local providers have no native JSON mode (only the
 * OpenAI-family clients send `response_format: json_object`), so a
 * compliant model still routinely wraps its `{ "summary": ... }` reply in a
 * ```json ... ``` fence or prefixes it with a sentence. `JSON.parse` then
 * throws and the caller would surface the raw fenced string as the
 * user-facing assessment. The extraction itself lives in
 * `src/lib/ai/json-extract.ts`, where the Anthropic client applies it on the
 * way out; this name stays for the insights callers.
 */
export function stripJsonFences(content: string): string {
  return extractJsonObject(content);
}

/**
 * Outcome of reading a status completion for its user-facing summary.
 *
 *   - `summary` — a `{ "summary": "…" }` envelope parsed to a non-empty
 *     string. Render it.
 *   - `prose`   — the model ignored the JSON contract and returned a plain
 *     sentence. Render it verbatim (back-compat with non-JSON-mode providers).
 *   - `unparseable` — the model ATTEMPTED the structured envelope but it came
 *     back malformed, truncated, or summary-less. There is NO safe text to
 *     render: the caller must fall back to its deterministic stub. This is the
 *     state that stops a partial `{ "summary": "…` (braces, property name,
 *     quotes, literal `\n`) from ever reaching the card — the class of bug
 *     reported against the resting-pulse Assessment.
 */
export type SummaryExtraction =
  | { kind: "summary"; text: string }
  | { kind: "prose"; text: string }
  | { kind: "unparseable" };

/**
 * Parse a candidate string as a `{ summary }` object. Reports whether the
 * string was valid JSON *object* at all (`parsed`) separately from whether it
 * carried a usable non-empty `summary` — so the caller can tell a malformed /
 * truncated envelope apart from a well-formed object that simply lacks the
 * field.
 */
function parseSummaryObject(candidate: string): {
  parsed: boolean;
  summary: string | null;
} {
  try {
    const obj = JSON.parse(candidate) as unknown;
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      const value = (obj as { summary?: unknown }).summary;
      if (typeof value === "string" && value.trim().length > 0) {
        return { parsed: true, summary: value };
      }
      // Well-formed object, but no usable summary (e.g. `{}` or `{summary:""}`).
      return { parsed: true, summary: null };
    }
    // Valid JSON, but not a summary object (array / number / bare string).
    return { parsed: false, summary: null };
  } catch {
    return { parsed: false, summary: null };
  }
}

/**
 * Did the completion OPEN like a JSON object? A genuine prose sentence never
 * starts with `{` (a stray brace mid-sentence does not count), so a `{`-led
 * payload that failed both parse attempts above is a malformed / truncated
 * envelope — never surfaced raw. Strips a leading code fence first so a
 * fenced-but-truncated object is caught too.
 */
function looksLikeJsonObjectAttempt(content: string): boolean {
  const afterFence = content.replace(/^```(?:json)?\s*/i, "").trimStart();
  return afterFence.startsWith("{");
}

/**
 * Read a model completion for its user-facing summary and classify the result.
 *
 * Tries the content as-is first (the common, fence-free case), then a
 * fence-stripped retry for providers without a native JSON mode. A completion
 * that attempted the `{ summary }` envelope but came back malformed / truncated
 * / summary-less resolves to `unparseable` rather than falling through as raw
 * text — the caller then serves its deterministic fallback. Only a completion
 * that never attempted the envelope (genuine prose) passes through verbatim.
 */
export function extractAssessmentSummary(content: string): SummaryExtraction {
  const trimmed = content.trim();

  // Attempt 1 — the content is itself a JSON object.
  const direct = parseSummaryObject(trimmed);
  if (direct.parsed) {
    return direct.summary
      ? { kind: "summary", text: direct.summary }
      : { kind: "unparseable" };
  }

  // Attempt 2 — strip a code fence / surrounding prose and retry.
  const stripped = stripJsonFences(trimmed);
  if (stripped !== trimmed) {
    const viaFence = parseSummaryObject(stripped);
    if (viaFence.parsed) {
      return viaFence.summary
        ? { kind: "summary", text: viaFence.summary }
        : { kind: "unparseable" };
    }
  }

  // Neither parse produced a summary object. If the payload OPENED like an
  // object, the model attempted the envelope and it came back malformed or
  // truncated — resolve to the controlled fallback, never the raw braces /
  // property name / quotes / literal `\n`. Genuine prose falls through.
  if (looksLikeJsonObjectAttempt(trimmed)) {
    return { kind: "unparseable" };
  }
  return { kind: "prose", text: content };
}

/**
 * Pull the `summary` string out of a model completion. The status prompts
 * return a `{ "summary": "…" }` envelope; a model that ignores the contract and
 * returns bare prose falls back to the raw content. A malformed / truncated /
 * summary-less structured envelope resolves to an EMPTY string (never the raw
 * JSON) so no caller can surface partial structured output.
 *
 * Prefer `extractAssessmentSummary` in new code: it distinguishes an
 * unparseable envelope from genuinely empty prose, which this thin wrapper
 * collapses to `""`.
 */
export function parseSummaryFromContent(content: string): string {
  const extracted = extractAssessmentSummary(content);
  return extracted.kind === "unparseable" ? "" : extracted.text;
}

/**
 * Persist one status assessment cache row in the standard text-only
 * shape (`{ dateKey, locale, text, providerType, model, tokensUsed }`).
 * Returns the row's `createdAt` ISO string. The medication-compliance
 * generator writes a richer `details` shape (per-medication array) and
 * keeps its own `auditLog.create` call.
 */
export async function persistStatusInsight(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  locale: SupportedLocale;
  text: string;
  providerType: string;
  model: string;
  tokensUsed: number | null;
  /**
   * v1.16.8 — fingerprint of the data snapshot this assessment was
   * generated from (see `snapshot-hash.ts`). The regeneration gate
   * compares the fresh snapshot's hash against this and skips the
   * provider call when nothing changed.
   */
  snapshotHash?: string;
  /**
   * v1.18.11 (P6) — cheap fingerprint of the SALIENT INPUTS (per-type
   * count + newest measuredAt) for slow-moving metrics. The input gate
   * compares a freshly probed fingerprint against this BEFORE the heavy
   * snapshot build, so a no-change day for weight/BMI skips the whole
   * gather (not just the provider call). Absent on metrics that don't
   * opt into the input gate.
   */
  inputHash?: string;
}): Promise<string> {
  const created = await prisma.auditLog.create({
    data: {
      userId: args.userId,
      action: args.cacheAction,
      details: JSON.stringify({
        dateKey: args.todayKey,
        locale: args.locale,
        text: args.text,
        providerType: args.providerType,
        model: args.model,
        tokensUsed: args.tokensUsed,
        statusKind: "generated",
        retryable: false,
        // Freshness is defined by the user's calendar day. Keeping the
        // boundary in the payload makes expiry explicit without inventing a
        // UTC timestamp for a day key that belongs to another timezone.
        expiresAfterDateKey: args.todayKey,
        ...(args.snapshotHash ? { snapshotHash: args.snapshotHash } : {}),
        ...(args.inputHash ? { inputHash: args.inputHash } : {}),
      }),
    },
    select: { createdAt: true },
  });
  return created.createdAt.toISOString();
}

/**
 * Outcome of turning one status-card completion into a shippable assessment.
 * `blocked` carries the tripped contract so the caller can annotate before it
 * withholds.
 */
export type StatusSummaryOutcome =
  | { ok: true; kind: "generated"; text: string }
  | {
      ok: false;
      kind: "screened-fallback";
      reason: OutboundReason | "unparseable_output";
    };

/**
 * The single finalize step every per-metric / biomarker / derived-score status
 * generator runs on its completion: parse the `{ summary }` envelope, scrub
 * chart tokens and whitespace, then SCREEN the prose against the insights
 * safety contracts.
 *
 * Why the screen belongs here. Before this existed, the only transform between
 * a provider and a persisted status assessment was `normalizeSummaryText`,
 * which is whitespace-only — so a dose-change imperative or a fabricated
 * clinical risk score written onto a metric card persisted as that day's cached
 * assessment while the identical sentence in the Coach was caught and replaced.
 * Every generator shares this chokepoint, so a card cannot be added that
 * silently skips the screen.
 *
 * SURFACE POLICY — WITHHOLD. Unlike the Coach, a status card is generated in
 * the background and read from cache; nobody is waiting on the turn. Persisting
 * a refusal is wrong (it would pin "I can't advise on doses" to the user's
 * Weight card for the day, which is noise on a surface they did not ask a
 * question on) and persisting the screened prose is obviously wrong. So the
 * caller serves its existing deterministic stub — the same signal-grounded line
 * the card shows when no provider is configured — and persists no model text.
 * The card degrades to a state the UI already renders honestly, and the short
 * negative-cache window lets the next run try again.
 *
 * The contracts include `causal` here: GROUND RULE 12 declares surface
 * `insights`, and these cards are that surface.
 */
export function finalizeStatusSummary(
  content: string,
  locale: SupportedLocale,
): StatusSummaryOutcome {
  const extracted = extractAssessmentSummary(content);
  // A malformed / truncated / summary-less structured envelope has no safe
  // text to render. WITHHOLD — the caller serves its deterministic stub. Only
  // the `unparseable` discriminator is logged, never the assessment content.
  if (extracted.kind === "unparseable") {
    return {
      ok: false,
      kind: "screened-fallback",
      reason: "unparseable_output",
    };
  }
  const text = normalizeSummaryText(extracted.text);
  if (!text) return { ok: true, kind: "generated", text: "" };
  const decision = screenModelOutput(text, locale, INSIGHTS_CONTRACTS);
  if (decision.block && decision.reason) {
    return {
      ok: false,
      kind: "screened-fallback",
      reason: decision.reason,
    };
  }
  return { ok: true, kind: "generated", text };
}
