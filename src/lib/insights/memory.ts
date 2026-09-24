/**
 * Insight memory — what the AI told this user last time.
 *
 * Every status generator (general / blood-pressure / weight / pulse /
 * bmi / medication-compliance / mood, and the generic metric cards) stores
 * its note in `InsightStatusCache`, named `insights.{scope}.{locale}`.
 * v1.4 turns that note into prompt context: the next generation
 * sees the previous classification + a short summary, so the model
 * can call out improvements and regressions instead of restating
 * status from scratch every day.
 *
 * Two consumers share this helper:
 *
 * - The status-generator pipeline reads the previous snapshot via
 *   `getPreviousInsightContext()` and injects it into the user prompt.
 * - The card UI reads the `delta` flag derived in
 *   `compareSnapshots()` and renders ↑/↓/→ glyphs next to findings.
 */

import { readPreviousStatusNote } from "@/lib/insights/status-cache";
import { instructionLocale } from "@/lib/ai/prompts/output-language";
import type { SupportedLocale } from "@/lib/insights/status-shared";

/**
 * Stable identifiers for the seven insight scopes. The string MUST
 * match the note name the generators store under (`statusCacheAction`).
 */
export type InsightScope =
  | "general-status"
  | "blood-pressure-status"
  | "weight-status"
  | "pulse-status"
  | "bmi-status"
  | "medication-compliance-status"
  | "mood-status";

/**
 * v1.8.7.1 — the generic per-HealthKit-metric assessments key their
 * previous-context rows under `insights.metric:<ID>-status.<locale>`, the
 * same `-status` action shape the seven specialised scopes use. Accept
 * that scope form alongside the seven so the generic generator can read
 * its comparison row without an `as never` cast that would silently
 * disable type checking on the argument.
 */
export type PreviousContextScope = InsightScope | `metric:${string}-status`;

export interface PreviousInsightContext {
  /** ISO timestamp the previous analysis was rendered. */
  generatedAt: string;
  /** Days between the previous analysis and now (rounded down). */
  ageDays: number;
  /**
   * Free-text snapshot of the previous analysis — typically the
   * `summary` field from `InsightResult` or the rendered narrative.
   * Already in the user's locale.
   */
  text: string;
}

/**
 * Read the stored note for `userId` + `scope` + `locale` when it is at
 * least `minAgeHours` old. Returns null when there is none (first-run
 * users) or it was written more recently than that.
 *
 * The default 12-hour floor keeps the model from comparing today's
 * 09:00 reading to today's 06:00 reading and treating sub-day noise as
 * a real change. Status generators pass shorter floors when force-
 * regenerating.
 */
export async function getPreviousInsightContext(
  userId: string,
  scope: PreviousContextScope,
  locale: SupportedLocale,
  minAgeHours: number = 12,
): Promise<PreviousInsightContext | null> {
  const action = `insights.${scope}.${locale}`;
  const olderThan = new Date(Date.now() - minAgeHours * 60 * 60 * 1000);

  const row = await readPreviousStatusNote({
    userId,
    cacheAction: action,
    olderThan,
  });
  if (!row) return null;
  const text = row.text;

  const ageMs = Date.now() - row.generatedAt.getTime();
  const ageDays = Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1000)));

  return {
    generatedAt: row.generatedAt.toISOString(),
    ageDays,
    // Cap text so a verbose previous analysis cannot bloat the prompt.
    text: text.length > 1500 ? text.slice(0, 1500) + "…" : text,
  };
}

/**
 * Format a previous-context block for direct injection into the user
 * prompt.
 *
 * The block is written in the same reviewed instruction body the prompt
 * composes (`instructionLocale`): German for a German reader, English for
 * everyone else. It is an INSTRUCTION to the model, not user-facing prose —
 * the reader's own language is named by the prompt's output-language
 * directive, so a French reader gets the English instruction block and a
 * French assessment. The former `locale === "en" ? EN : DE` handed the
 * GERMAN block to fr/es/it/pl.
 *
 * Example (de):
 *   "VORHERIGE ANALYSE (vor 7 Tagen, 2026-05-01):
 *    Dein Blutdruck war im Schnitt 132/85 — grenzwertig. …"
 */
export function formatPreviousContextForPrompt(
  ctx: PreviousInsightContext | null,
  locale: SupportedLocale,
): string {
  const body = instructionLocale(locale);
  if (!ctx) {
    return body === "en"
      ? "PREVIOUS ANALYSIS: none on file. Treat this as the user's first analysis for this domain — no improvement/regression delta to surface."
      : "VORHERIGE ANALYSE: keine vorhanden. Behandle dies als erste Analyse in diesem Bereich — kein Verbesserungs-/Verschlechterungs-Delta zu nennen.";
  }

  const dateLabel = ctx.generatedAt.slice(0, 10);
  if (body === "en") {
    const ageLabel =
      ctx.ageDays === 0
        ? "earlier today"
        : ctx.ageDays === 1
          ? "1 day ago"
          : `${ctx.ageDays} days ago`;
    return [
      `PREVIOUS ANALYSIS (${ageLabel}, ${dateLabel}):`,
      ctx.text,
      "",
      'INSTRUCTION: When summarising the current state, explicitly call out what improved, what regressed, and what stayed the same compared to that previous snapshot. Use phrases like "down 4 mmHg from your last check" or "same elevated trend as last week". Do not invent numbers — only compare what\'s in the snapshot below.',
    ].join("\n");
  }

  const ageLabel =
    ctx.ageDays === 0
      ? "heute früher"
      : ctx.ageDays === 1
        ? "vor 1 Tag"
        : `vor ${ctx.ageDays} Tagen`;
  return [
    `VORHERIGE ANALYSE (${ageLabel}, ${dateLabel}):`,
    ctx.text,
    "",
    'ANWEISUNG: Wenn du den aktuellen Stand zusammenfasst, benenne explizit was sich verbessert hat, was schlechter geworden ist und was gleich geblieben ist gegenüber dieser vorherigen Analyse. Verwende Formulierungen wie "4 mmHg niedriger als beim letzten Check" oder "gleicher erhöhter Trend wie letzte Woche". Erfinde keine Zahlen — vergleiche nur das, was im Snapshot unten steht.',
  ].join("\n");
}
