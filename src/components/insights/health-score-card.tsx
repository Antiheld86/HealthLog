"use client";

import { useId, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CornerDownLeft,
  Minus,
  Moon,
  Scale,
} from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { readStoredTimezone } from "@/lib/timezone-mirror";
import { cn } from "@/lib/utils";
import { HealthScoreDeltaExplainer } from "./health-score-delta-explainer";

/**
 * v1.4.20 B5 — Personal Health Score panel.
 *
 * Lives on the right side of the `<HeroStrip>` band on `lg+` viewports
 * and stacks below the title block on `<lg`. Surfaces:
 *   - the composite 0..100 score with a band-coloured number
 *   - "vs last week" delta line with arrow + percentage
 *   - 4 component rows (BP / Weight / Mood / Compliance) with sub-bars
 *   - "Indicative — not a clinical assessment" disclaimer
 *   - "Ask the Coach" button that opens the B2 drawer with a prefill
 *     ("Why is my health score X out of 100?") so the user can drill
 *     into the explanation without retyping the question
 *
 * v1.4.25 W8e — collapsible "Driven by" provenance accordion appended
 * below the component sub-bars. Each row shows the value bar, the
 * effective weight share, and a source pill so the user can see which
 * ingest path produced each pillar. A "mixed source" banner fires when
 * at least one component blends entries from more than one source.
 *
 * Pure presentational — the parent owns the analytics query + the
 * drawer state. The card mounts no inline Coach affordance; the hero
 * strip carries the single "Ask the coach" entry point.
 */

export type HealthScoreBand = "green" | "yellow" | "red";

/**
 * v1.4.25 W8e — per-component source attribution. Mirrors the analytics
 * `HealthScoreComponentSource` type (intentional duplication so the
 * client doesn't pull a heavy analytics import for one string union).
 */
export type HealthScoreComponentSource =
  "manual" | "withings" | "appleHealth" | "mixed" | "none";

export interface HealthScoreCardComponent {
  value: number | null;
  weight: number;
  /**
   * v1.4.25 W8e — optional source label. When omitted the row falls
   * back to `manual` for present values / `none` for null values.
   */
  source?: HealthScoreComponentSource;
  /**
   * v1.4.25 W8e — optional ISO timestamp of the freshest contributing
   * measurement. The provenance accordion surfaces it under "as of
   * {date}" on each row.
   */
  asOf?: string;
}

export interface HealthScoreCardProps {
  score: number;
  band: HealthScoreBand;
  components: {
    bp: HealthScoreCardComponent;
    weight: HealthScoreCardComponent;
    mood: HealthScoreCardComponent;
    compliance: HealthScoreCardComponent;
  };
  delta: number | null;
  /**
   * v1.4.25 W8e — opens the provenance accordion on first render.
   * The SSR tests use it to exercise the expanded markup without a
   * `useEffect` round-trip; in production the user-driven toggle
   * starts collapsed.
   */
  initiallyExpanded?: boolean;
  /**
   * v1.18.0 R4 — when the `mood` module is disabled for the account the
   * server already drops the mood-stability pillar from the score (the
   * pillar arrives null-weighted). This hides the Mood row from the
   * component + provenance lists too so the card never advertises a
   * pillar the user turned off. Default-on so omitting it keeps the
   * four-row layout for the common (mood-enabled) case.
   */
  moodEnabled?: boolean;
  /**
   * v1.18.6 — Rest Mode annotation. When an illness episode is active the
   * server suppresses (never penalises) the score; the card itself then
   * carries an explicit "paused during illness — not being judged today"
   * line so a frozen/held number reads as intentional rather than as a
   * silent drop. Value-free: the card only needs to know that it is
   * active, not the episode details. Default off (the common case).
   */
  restModeActive?: boolean;
  /**
   * v1.21.2 (A5) — Tension Verdict line. The server resolves the honest
   * "internal read" when the readiness/recovery composite's contributors
   * DISAGREE (good sleep but a rising resting pulse, …). The card renders it
   * as one short line: the favourable contributor, the unfavourable one, and
   * the band the composite lands on. Purely DTO-rendered — the card never
   * recomputes the disagreement. Absent (the common case) when the
   * contributors agree.
   */
  tension?: {
    band: HealthScoreBand;
    /** Favourable contributors, already localised by the resolver. */
    positive: string[];
    /** Unfavourable contributors, already localised by the resolver. */
    negative: string[];
  } | null;
  /**
   * v1.21.2 (A6) — return-to-baseline line. Present only when a metric has
   * come BACK inside the user's own usual range after a prior out-of-band run.
   * Actively closes a worry ("back inside your usual range after last week's
   * dip"). Server-resolved DTO; the label is already localised.
   */
  returnToBand?: {
    /** The metric's display label, already localised by the resolver. */
    metricLabel: string;
    /** Days the metric has now sat back inside its range. */
    daysInside: number;
  } | null;
}

type ComponentKey = keyof HealthScoreCardProps["components"];

const SOURCE_LABEL_KEY: Record<HealthScoreComponentSource, string> = {
  manual: "insights.healthScore.provenance.sources.manual",
  withings: "insights.healthScore.provenance.sources.withings",
  appleHealth: "insights.healthScore.provenance.sources.appleHealth",
  mixed: "insights.healthScore.provenance.sources.mixed",
  none: "insights.healthScore.provenance.sources.none",
};

/**
 * Per-source pill colour vocabulary — mirrors the Coach provenance
 * `<SourceChips>` accent for `withings` (info/cyan) so the user reads
 * "same provenance grammar across surfaces". Routed through the
 * theme-aware semantic tokens (dose-accent / info / warning) which carry
 * an AA-safe override in light mode; the raw `--dracula-*` text primitives
 * read illegibly there. The pill always renders its source label, so the
 * label — not the hue — is the disambiguator. `none` is a muted slate so
 * the empty-state row reads as dimmed without losing the pill affordance.
 */
const SOURCE_PILL_CLASS: Record<HealthScoreComponentSource, string> = {
  manual: "border-dose-accent/30 text-dose-accent/90",
  withings: "border-info/30 text-info/90",
  appleHealth: "border-dose-accent/30 text-dose-accent/90",
  mixed: "border-warning/30 text-warning/90",
  none: "border-muted-foreground/30 text-muted-foreground",
};

// v1.12.4 — the headline score number used the raw `--dracula-*` primitives,
// which carry no light-mode override and render illegibly on the Alucard
// light theme (the band-tokens helper documents the same trap). Route through
// the semantic `--success` / `--warning` / `--destructive` tokens, which both
// themes override to an AA-safe tone — same mapping the wellness-score rings
// already use.
const BAND_NUMBER_CLASS: Record<HealthScoreBand, string> = {
  green: "text-success",
  yellow: "text-warning",
  red: "text-destructive",
};

const BAND_BORDER_CLASS: Record<HealthScoreBand, string> = {
  green: "border-success/40",
  yellow: "border-warning/40",
  red: "border-destructive/40",
};

const BAND_PROGRESS_CLASS: Record<HealthScoreBand, string> = {
  green: "bg-success",
  yellow: "bg-warning",
  red: "bg-destructive",
};

const COMPONENT_LABEL_KEY: Record<
  keyof HealthScoreCardProps["components"],
  string
> = {
  bp: "insights.healthScore.componentBp",
  weight: "insights.healthScore.componentWeight",
  mood: "insights.healthScore.componentMood",
  compliance: "insights.healthScore.componentCompliance",
};

// v1.4.25 W8e — provenance row order. Module-scope so the array is
// allocated once per process rather than on every card render; the
// downstream `.map()` is non-mutating, so a fresh copy isn't needed.
const COMPONENT_ORDER: readonly ComponentKey[] = [
  "bp",
  "weight",
  "mood",
  "compliance",
];

export function HealthScoreCard({
  score,
  band,
  components,
  delta,
  initiallyExpanded = false,
  moodEnabled = true,
  restModeActive = false,
  tension = null,
  returnToBand = null,
}: HealthScoreCardProps) {
  const { t, locale } = useTranslations();
  // The asOf timestamps render under the source pill as a tooltip
  // (`title`) so the row layout stays one-line. Dates format via the
  // user's locale to honour the EU comma / dot convention; on bad input
  // we fall through to the raw ISO so the user still sees something.
  // The formatter is memoised per locale so the row map below doesn't
  // build a fresh `Intl.DateTimeFormat` instance per row.
  // The timezone is as load-bearing as the locale and was missing: without it
  // the formatter used the browser's, so a reading taken late in the evening
  // could print yesterday's date for someone whose profile timezone is east of
  // where their laptop happens to be. The locale still decides the separator
  // convention; the timezone decides which day it was.
  const asOfFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        // `readStoredTimezone` returns "" when nothing is stored or during
        // SSR, and an empty string makes Intl throw RangeError rather than
        // fall back. `undefined` is the value that means "use the default".
        timeZone: readStoredTimezone() || undefined,
      }),
    [locale],
  );
  const formatAsOf = (asOf: string | null): string | null => {
    if (!asOf) return null;
    const parsed = new Date(asOf);
    if (Number.isNaN(parsed.getTime())) return null;
    return asOfFormatter.format(parsed);
  };
  // v1.21.2 (A5) — locale-aware conjunction list for the Tension Verdict's
  // favourable / unfavourable contributor lists ("sleep and mood" / "resting
  // heart rate, HRV balance, and mood"). Memoised per locale.
  const listFormatter = useMemo(
    () => new Intl.ListFormat(locale, { style: "long", type: "conjunction" }),
    [locale],
  );
  const [expanded, setExpanded] = useState(initiallyExpanded);
  // `useId` keeps the aria-controls/section-id pair unique even when
  // the card is mounted twice on the same page (lg+ hero strip vs
  // smaller stacked previews in tests).
  const panelId = useId();
  // FB-I1 a11y — id wired from the delta `<span>` (aria-describedby)
  // to the explainer popover/sheet body. The thread lets screen
  // readers connect "−3 vs last week" to the three-sentence read
  // without relying on visual proximity alone.
  const deltaExplainerId = useId();

  // v1.18.0 R4 — drop the Mood pillar from the card's row lists when the
  // module is disabled. The server already null-weights it in the score;
  // hiding the row keeps the card from naming a pillar the account turned
  // off (it would otherwise render as a permanently empty "Mood" line).
  const visibleKeys = (Object.keys(components) as Array<ComponentKey>).filter(
    (key) => moodEnabled || key !== "mood",
  );
  const componentEntries = visibleKeys.map((key) => ({
    key,
    label: t(COMPONENT_LABEL_KEY[key]),
    value: components[key].value,
  }));

  // v1.4.25 W8e — sort the provenance rows by effective weight
  // descending so the biggest contributor sits first. Components with
  // null values sink to the bottom (`weight * 0 === 0`); the tie-break
  // is the alphabetical key order so determinism holds across renders.
  const provenanceRows = COMPONENT_ORDER.filter(
    (key) => moodEnabled || key !== "mood",
  )
    .map((key) => {
      const c = components[key];
      const inferredSource: HealthScoreComponentSource =
        c.source ?? (c.value === null ? "none" : "manual");
      return {
        key,
        label: t(COMPONENT_LABEL_KEY[key]),
        value: c.value,
        weight: c.weight,
        source: inferredSource,
        asOf: c.asOf ?? null,
        effective: c.weight * (c.value !== null ? 1 : 0),
      };
    })
    .sort((a, b) => b.effective - a.effective || a.key.localeCompare(b.key));

  const presentCount = provenanceRows.filter((r) => r.value !== null).length;
  const totalCount = provenanceRows.length;
  const hasMixed = provenanceRows.some((r) => r.source === "mixed");
  // v1.4.25 W8e — "provisional" when less than half of the configured
  // inputs have data. Subtle badge above the headline number; copy is
  // localised via `provenance.provisional`.
  const isProvisional =
    totalCount > 0 && presentCount > 0 && presentCount < totalCount / 2;

  return (
    <div
      data-slot="health-score-card"
      data-band={band}
      className={cn(
        "bg-card/65 rounded-xl border p-4 shadow-sm backdrop-blur-sm md:p-6",
        BAND_BORDER_CLASS[band],
        // v1.4.27 MB7 / CF-34 — basis-based width so the score column
        // flexes inside the hero strip's `md:flex-row` split. Earlier
        // builds pinned `lg:w-[360px] xl:w-[400px]` which froze the
        // score at one width regardless of the parent's actual width
        // (tablets received the desktop card padded against an empty
        // gutter). The basis values still bias the column generous
        // (~36 % at md, ~40 % at xl) but cede headroom when the parent
        // narrows.
        "w-full md:shrink-0 md:grow-0 md:basis-[22rem] xl:basis-[26rem]",
        // v1.4.28 R3c-Insights — stretch to match the parent's
        // `items-stretch` row height (FB-H1/H2). `h-full` + an inner
        // flex column lets the disclaimer ride to the bottom with
        // `mt-auto` so the headline number stays at the top and the
        // recovered vertical space pads through the middle rather
        // than under the disclaimer.
        "flex h-full flex-col",
      )}
    >
      {/* v1.4.37 W4a item 1 — swap the inner column from `flex
          flex-col` to a 7-row grid so the recovered vertical slack
          (when the parent hero-row stretches the card past the
          natural content height) collects on row 6 (the provenance
          accordion) instead of clumping under the disclaimer. The
          score number stays anchored at the top, the disclaimer at
          the bottom, and the card fills the row down to the
          "Wirkt mein Medikament?" chip — closing the maintainer's "Karte hört
          bei der Trennlinie auf" report against v1.4.36. */}
      <div className="grid flex-1 grid-rows-[auto_auto_auto_auto_auto_1fr_auto] gap-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <p
              data-slot="health-score-card-label"
              className="text-muted-foreground text-xs font-semibold tracking-[0.18em] uppercase"
            >
              {t("insights.healthScore.label")}
            </p>
            {isProvisional && (
              <span
                data-slot="health-score-card-provisional-badge"
                className="border-muted-foreground/30 text-muted-foreground inline-flex items-center rounded-full border px-1.5 py-0.5 text-xs font-medium tracking-wide uppercase"
                title={t("insights.healthScore.provenance.provisional", {
                  count: presentCount,
                  total: totalCount,
                })}
              >
                {t("insights.healthScore.provenance.provisionalBadge")}
              </span>
            )}
          </div>
          {delta !== null && delta > 0 && (
            <span
              data-slot="health-score-card-delta-chip"
              className="bg-success/15 text-success rounded-full px-2 py-0.5 text-xs font-semibold"
            >
              +{delta}
            </span>
          )}
        </div>

        <div className="flex items-baseline gap-1">
          <span
            data-slot="health-score-card-number"
            className={cn(
              // v1.4.27 B1 — bumped from text-4xl to text-5xl
              // (sm:text-6xl on wider viewports) so the headline
              // number becomes the visual centre of gravity of the
              // expanded card.
              "text-5xl leading-none font-semibold tabular-nums sm:text-6xl",
              BAND_NUMBER_CLASS[band],
            )}
          >
            {score}
          </span>
          <span
            aria-hidden="true"
            className="text-muted-foreground text-sm tabular-nums"
          >
            / 100
          </span>
        </div>

        <div
          data-slot="health-score-card-progress"
          className="bg-muted/50 h-2 w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={score}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("insights.healthScore.progressAria")}
        >
          <div
            className={cn("h-full transition-all", BAND_PROGRESS_CLASS[band])}
            style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
          />
        </div>

        {/* v1.4.28 R3c-Insights — FB-I1 — the delta line gets a
            sibling `?` glyph that opens a 3-sentence read of which
            components contributed, what the comparison window is,
            and one concrete next step. Popover on `md+`, bottom-sheet
            on phone-class viewports. The explainer only mounts when
            a numeric delta is available; the "no history yet"
            branch keeps the existing single-line caption. */}
        {/* The delta digit and the explainer caption stack — the caption
            is a multi-sentence read, and rendering it INSIDE the delta's
            inline-flex row squeezed the short delta line into a narrow
            multi-line column beside it on every viewport. The delta line
            keeps its icon row; the caption sits below at full width. */}
        <div
          data-slot="health-score-card-delta"
          className="text-muted-foreground space-y-1 text-xs"
        >
          {delta === null ? (
            <p>{t("insights.healthScore.deltaUnavailable")}</p>
          ) : (
            <>
              <p className="flex items-center gap-1">
                {delta > 0 && (
                  <ArrowUp
                    className="text-success h-3 w-3"
                    aria-hidden="true"
                  />
                )}
                {delta < 0 && (
                  <ArrowDown
                    className="text-destructive h-3 w-3"
                    aria-hidden="true"
                  />
                )}
                {delta === 0 && (
                  <Minus
                    className="text-muted-foreground h-3 w-3"
                    aria-hidden="true"
                  />
                )}
                <span aria-describedby={deltaExplainerId}>
                  {t("insights.healthScore.deltaVsLastWeek", {
                    delta: delta > 0 ? `+${delta}` : `${delta}`,
                  })}
                </span>
              </p>
              <HealthScoreDeltaExplainer
                className="block"
                delta={delta}
                bodyId={deltaExplainerId}
              />
            </>
          )}
        </div>

        {/* v1.18.6 — Rest Mode legibility. While an illness episode is
            active the server suppresses (never penalises) the score, so
            the card states plainly that the number is paused and not being
            judged today. Without this the held score reads as a silent
            decline. */}
        {restModeActive && (
          <p
            data-slot="health-score-card-rest-mode"
            className="text-muted-foreground inline-flex items-start gap-1.5 text-xs leading-relaxed"
          >
            <Moon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            <span>{t("insights.healthScore.restModePaused")}</span>
          </p>
        )}

        {/* v1.21.2 (A5) — Tension Verdict. The honest "internal read" when the
            composite's contributors disagree, resolved server-side and rendered
            as one short line. The card never recomputes the disagreement; it
            only renders the resolved favourable / unfavourable contributors and
            the band the composite lands on. */}
        {tension &&
          tension.positive.length > 0 &&
          tension.negative.length > 0 && (
            <p
              data-slot="health-score-card-tension"
              data-band={tension.band}
              className="text-muted-foreground inline-flex items-start gap-1.5 text-xs leading-relaxed"
            >
              <Scale className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              <span>
                {t("insights.tension.label", {
                  positive: listFormatter.format(tension.positive),
                  negative: listFormatter.format(tension.negative),
                  band: t(`insights.tension.contributor.${tension.band}`),
                })}
              </span>
            </p>
          )}

        {/* v1.21.2 (A6) — return-to-baseline. Present only when a metric came
            back inside the user's own usual range after a prior out-of-band run.
            Actively closes a worry rather than reporting a number. */}
        {returnToBand && (
          <p
            data-slot="health-score-card-return-to-band"
            className="text-success/90 inline-flex items-start gap-1.5 text-xs leading-relaxed"
          >
            <CornerDownLeft
              className="mt-0.5 size-3 shrink-0"
              aria-hidden="true"
            />
            <span>
              {t("insights.streak.returnLabel", {
                metric: returnToBand.metricLabel,
                count: returnToBand.daysInside,
              })}
            </span>
          </p>
        )}

        <ul
          data-slot="health-score-card-components"
          // v1.8.5 W4a — the always-visible "Zusammensetzung" breakdown is
          // the natural place to add weight to the Health-Score card so it
          // fills the hero-row height instead of leaving the right column
          // short and bottom-empty. Loosen the row rhythm (`space-y-2.5` vs
          // `space-y-1.5`) and the divider stride (`pt-3.5`) so the four
          // component bars read as a richer block; no new data, no new row.
          className="space-y-2.5 border-t pt-3.5"
        >
          {componentEntries.map(({ key, label, value }) => (
            <li
              key={key}
              data-slot="health-score-card-component-row"
              data-component={key}
              className="flex items-center gap-2 text-xs"
            >
              {/* v1.4.25 W3 — widened label column from w-16 (64px) to
                  w-24 (96px) so the longest German label
                  ("Einnahmetreue" — 13 chars at 11px) sits inside the
                  column without spilling into the bar/value chip. */}
              <span className="text-muted-foreground w-24 shrink-0 truncate">
                {label}
              </span>
              <div
                className="bg-muted/50 h-1.5 flex-1 overflow-hidden rounded-full"
                aria-hidden="true"
              >
                <div
                  className={cn(
                    "h-full",
                    value === null ? "bg-muted" : BAND_PROGRESS_CLASS[band],
                  )}
                  style={{
                    width:
                      value === null
                        ? "0%"
                        : `${Math.max(0, Math.min(100, value))}%`,
                  }}
                />
              </div>
              <span
                data-slot="health-score-card-component-value"
                className="text-foreground w-8 shrink-0 text-right tabular-nums"
              >
                {value === null ? "—" : Math.round(value)}
              </span>
            </li>
          ))}
        </ul>

        {/* v1.4.25 W8e — tap-to-expand provenance accordion.
            Kept inside the card so the visual "owner" of the
            breakdown remains the score tile (concept-cohesion).
            No top border here — the components list above already
            owns the divider stride; a second border would read
            visually heavy. */}
        <div className="-mt-1">
          <button
            type="button"
            id={`${panelId}-toggle`}
            data-slot="health-score-card-provenance-toggle"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => setExpanded((v) => !v)}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
              "flex w-full items-center justify-between gap-1 rounded text-xs",
            )}
          >
            <span>{t("insights.healthScore.provenance.toggle")}</span>
            <ChevronDown
              className={cn(
                "h-3 w-3 transition-transform",
                expanded && "rotate-180",
              )}
              aria-hidden="true"
            />
          </button>

          {expanded && (
            <section
              id={panelId}
              aria-labelledby={`${panelId}-toggle`}
              data-slot="health-score-card-provenance-panel"
              className="mt-2 space-y-1.5"
            >
              {hasMixed && (
                <p
                  data-slot="health-score-card-provenance-mixed-banner"
                  role="status"
                  className="border-warning/30 text-warning/90 bg-warning/5 rounded border px-2 py-1 text-xs leading-snug"
                >
                  {t("insights.healthScore.provenance.mixedBanner")}
                </p>
              )}
              <ul
                data-slot="health-score-card-provenance-rows"
                className="space-y-1.5"
              >
                {provenanceRows.map((row) => {
                  const sourceLabel = t(SOURCE_LABEL_KEY[row.source]);
                  const isEmpty = row.source === "none" || row.value === null;
                  const asOfFormatted = formatAsOf(row.asOf);
                  const asOfLine = asOfFormatted
                    ? t("insights.healthScore.provenance.asOfLabel", {
                        date: asOfFormatted,
                      })
                    : null;
                  return (
                    <li
                      key={row.key}
                      data-slot="health-score-card-provenance-row"
                      data-component={row.key}
                      data-source={row.source}
                      className={cn(
                        "flex items-center gap-2 text-xs",
                        isEmpty && "opacity-50",
                      )}
                    >
                      <span className="text-muted-foreground w-20 shrink-0 truncate">
                        {row.label}
                      </span>
                      {/* value bar — same vocabulary as the existing
                          sub-bar row so the two stride lines align */}
                      <div
                        className="bg-muted/50 h-1 flex-1 overflow-hidden rounded-full"
                        aria-hidden="true"
                      >
                        <div
                          className={cn(
                            "h-full",
                            isEmpty ? "bg-muted" : BAND_PROGRESS_CLASS[band],
                          )}
                          style={{
                            width: isEmpty
                              ? "0%"
                              : `${Math.max(0, Math.min(100, row.value ?? 0))}%`,
                          }}
                        />
                      </div>
                      <span
                        data-slot="health-score-card-provenance-value"
                        className="text-foreground w-8 shrink-0 text-right tabular-nums"
                      >
                        {row.value === null ? "—" : Math.round(row.value)}
                      </span>
                      {/* weight share — second, narrower bar tinted with
                          the `info` token to read "provenance grammar"
                          alongside the Coach <SourceChips> accent */}
                      <div
                        className="bg-muted/40 h-1 w-10 shrink-0 overflow-hidden rounded-full"
                        aria-hidden="true"
                      >
                        <div
                          className={cn(
                            "h-full",
                            isEmpty ? "bg-muted" : "bg-info/60",
                          )}
                          style={{
                            width: isEmpty
                              ? "0%"
                              : `${Math.max(0, Math.min(100, row.weight * 100))}%`,
                          }}
                        />
                      </div>
                      <span
                        data-slot="health-score-card-provenance-pill"
                        aria-label={t(
                          "insights.healthScore.provenance.sourceAria",
                          { source: sourceLabel },
                        )}
                        title={asOfLine ?? undefined}
                        data-as-of={row.asOf ?? undefined}
                        className={cn(
                          "inline-flex items-center rounded-full border bg-transparent px-1.5 py-0.5 text-xs leading-none",
                          SOURCE_PILL_CLASS[row.source],
                        )}
                      >
                        {sourceLabel}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p
                data-slot="health-score-card-provenance-footnote"
                className="text-muted-foreground text-xs leading-snug"
              >
                {t("insights.healthScore.provenance.footnote")}
              </p>
            </section>
          )}
        </div>

        {/* v1.18.6 (DISC-01) — the "indicative, not a clinical assessment"
            card disclaimer is removed; the one-time onboarding acknowledgment
            now covers the not-a-diagnosis framing app-wide. */}
      </div>
    </div>
  );
}
