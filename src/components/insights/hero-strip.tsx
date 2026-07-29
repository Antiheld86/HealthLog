"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useTranslations,
  useFormatters,
  useDisplayTimezone,
} from "@/lib/i18n/context";
import { formatUpdatedLabel } from "@/lib/i18n/relative-time";
import { useAuth } from "@/hooks/use-auth";
import { hourInTz, DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { ProseBlocks } from "@/components/insights/prose-blocks";
import { cn } from "@/lib/utils";
import { HealthScoreCard } from "./health-score-card";
import type { HealthScoreReport, ScoreBand } from "@/lib/analytics/score/types";
import type { DailyBriefing as DailyBriefingPayload } from "@/lib/ai/schema";

/**
 * v1.21.2 (A5) — readiness contributor keys the Tension Verdict surfaces. Kept
 * as a local string union so the client never imports the server derived-engine
 * types. Localised through the existing
 * `insights.derived.composite.READINESS.component.{key}` labels.
 */
export type ReadinessContributorKey =
  "rhr" | "hrv" | "sleep" | "respiratory" | "mood";

/**
 * Insights redesign hero strip.
 *
 * The wider band lifted from the design handoff
 * (`prototype/artboard-fullpage.jsx → BriefingHero`):
 *
 *   - locale-aware time-of-day greeting line ("Good morning, …" /
 *     "Guten Morgen, …") + a narrative subtitle (the briefing
 *     paragraph when one is cached, else a fallback)
 *   - personal-baseline + "Generated <relative-time>" meta row
 *   - Dracula gradient + soft purple glow via the new `.hero-gradient`
 *     + `.glow-purple` utilities in `globals.css`
 *
 * v1.18.7 — the overview "Ask the coach" action row + guided-questions
 * chip strip were removed from the band. The Coach lives in the
 * bottom-right drawer (mounted by the insights layout shell); the
 * overview now leads with the present-focused daily briefing, not a
 * coach prompt. The hero is greeting + subtitle + baseline meta + the
 * optional right-side Health Score panel.
 *
 * Pure presentational — the page owns the briefing data.
 */

interface HeroStripProps {
  /** Briefing payload — its paragraph drives the hero subtitle. */
  briefing: DailyBriefingPayload | null;
  /** ISO timestamp of the freshest cached payload. */
  updatedAt?: string | null;
  /**
   * Display name for the greeting; defaults to no-name greeting
   * ("Good morning,") when omitted so the hero never paints "Good
   * morning, undefined".
   */
  userName?: string | null;
  /**
   * Now() override for tests so the greeting bucket is deterministic.
   * Defaults to `new Date()`. Production callers omit this.
   */
  now?: Date;
  /**
   * v1.18.9 (#4) — true when the hero subtitle is drawn from a cached
   * briefing that can never refresh because no AI provider is connected.
   * The meta row then appends a discreet "connect a provider" link beside
   * the "Generated <relative>" age, so the score-area context reads as
   * honestly held rather than current. Consistent with the DailyBriefing
   * footer hint below.
   */
  noProviderStale?: boolean;
  /** Complete transparent Health Score report from the analytics route. */
  healthScore?: HealthScoreReport | null;
  /**
   * v1.21.2 (A5) — Tension Verdict, server-resolved + locale-agnostic. `band`
   * is the readiness composite's band; `positive` / `negative` carry the
   * readiness contributor KEYS (`rhr` / `hrv` / `sleep` / `respiratory` /
   * `mood`). The hero localises each key through the existing
   * `insights.derived.composite.READINESS.component.*` labels before handing the
   * score card its already-localised strings. Null on a coherent day (or under a
   * clinical red-flag suppress). The score card carries it only when the score
   * is present.
   */
  tension?: {
    band: ScoreBand;
    positive: ReadinessContributorKey[];
    negative: ReadinessContributorKey[];
  } | null;
  /**
   * v1.21.2 (A6) — return-to-baseline, server-resolved + locale-agnostic.
   * `metricType` is a `MeasurementType` the hero maps to its localised metric
   * name (the existing `measurements.type*` keys). Null when no salient metric
   * returned from a genuine prior out-of-band run.
   */
  returnToBand?: {
    metricType: string;
    daysInside: number;
  } | null;
  /**
   * v1.16.8 — true while the analytics payload that carries
   * `healthScore` is still in flight. The right column then reserves the
   * score card's footprint with a skeleton, so the hero band paints at
   * roughly its final size from the first frame and the card landing is
   * a swap, not a push. Pre-fix the column collapsed while loading and
   * the whole overview reflowed when the (slow, thick-slice) analytics
   * response arrived — the "greeting first, score card later" stagger.
   * When the payload resolves WITHOUT a score (no data yet) the column
   * collapses once, which is the legacy no-score shape.
   */
  healthScorePending?: boolean;
}

/**
 * Bucketed time-of-day greeting:
 *   05:00–11:59 → morning
 *   12:00–17:59 → afternoon
 *   18:00–22:59 → evening
 *   23:00–04:59 → night (mapped to "evening" for both locales — it's
 *                        rare to see /insights at 03:00 and "Guten
 *                        Morgen" pre-5am reads odd)
 */
function resolveGreetingKey(hour: number): string {
  if (hour >= 5 && hour < 12) return "insights.heroGreetingMorning";
  if (hour >= 12 && hour < 18) return "insights.heroGreetingAfternoon";
  // 18:00-22:59 maps to "Good evening"; 23:00-04:59 also maps to
  // "Good evening" — reading "Good morning" pre-5am felt off, and
  // German has the same fall-through. Drop the duplicate Night key.
  return "insights.heroGreetingEvening";
}

/**
 * v1.21.2 (A5) — readiness contributor key → existing localised label key.
 * Reuses the score-anatomy contributor labels so the Tension Verdict reads the
 * same names the wellness ring's anatomy view renders — no new keys.
 */
const TENSION_CONTRIBUTOR_LABEL_KEY: Record<ReadinessContributorKey, string> = {
  rhr: "insights.derived.composite.READINESS.component.rhr",
  hrv: "insights.derived.composite.READINESS.component.hrv",
  sleep: "insights.derived.composite.READINESS.component.sleep",
  respiratory: "insights.derived.composite.READINESS.component.respiratory",
  mood: "insights.derived.composite.READINESS.component.mood",
};

/**
 * v1.21.2 (A6) — `MeasurementType` → existing localised metric-name key
 * (`measurements.type*`). Only the salient deviation vitals the
 * return-to-baseline detector scans need an entry; an unmapped type falls back
 * to a prettified raw form so a new type never blanks.
 */
const RETURN_METRIC_LABEL_KEY: Record<string, string> = {
  RESTING_HEART_RATE: "measurements.typeRestingHeartRate",
  HEART_RATE_VARIABILITY: "measurements.typeHeartRateVariability",
  RESPIRATORY_RATE: "measurements.typeRespiratoryRate",
  WEIGHT: "measurements.typeWeight",
};

export function HeroStrip({
  briefing,
  updatedAt,
  userName,
  now,
  healthScore,
  healthScorePending = false,
  noProviderStale = false,
  tension = null,
  returnToBand = null,
}: HeroStripProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  // Issue #490 — the SAME resolved zone `fmt.time` renders in (mirror →
  // Berlin), so the today/yesterday boundary and the clock can never split.
  const displayTz = useDisplayTimezone();

  // v1.21.2 (A5) — localise the Tension Verdict's contributor keys into the
  // card's already-localised `{ positive, negative }` shape. Only forwarded when
  // a real disagreement is present on BOTH sides; the resolver already enforces
  // that, but the guard keeps the card from rendering a one-sided line.
  const tensionProp =
    tension && tension.positive.length > 0 && tension.negative.length > 0
      ? {
          band: tension.band,
          positive: tension.positive.map((k) =>
            t(TENSION_CONTRIBUTOR_LABEL_KEY[k]),
          ),
          negative: tension.negative.map((k) =>
            t(TENSION_CONTRIBUTOR_LABEL_KEY[k]),
          ),
        }
      : null;

  // v1.21.2 (A6) — localise the return-to-baseline metric into the card's
  // already-localised `metricLabel`.
  const returnToBandProp = returnToBand
    ? {
        metricLabel: RETURN_METRIC_LABEL_KEY[returnToBand.metricType]
          ? t(RETURN_METRIC_LABEL_KEY[returnToBand.metricType])
          : returnToBand.metricType.replace(/_/g, " ").toLowerCase(),
        daysInside: returnToBand.daysInside,
      }
    : null;
  // Greeting hour in the user's configured zone, not the browser's — a
  // traveller / VPN user / wrong device clock otherwise sees the wrong
  // salutation. Mirrors the dashboard hero (`hourInTimezone(now, userTz)`).
  const greetingHour = hourInTz(
    now ?? new Date(),
    user?.timezone ?? DEFAULT_TIMEZONE,
  );
  const greetingKey = resolveGreetingKey(greetingHour);
  const greetingBase = t(greetingKey);
  const greeting = userName ? `${greetingBase}, ${userName}` : greetingBase;
  const subtitle = briefing?.paragraph ?? t("insights.heroFallbackSubtitle");
  // v1.22 — calendar-bucketed freshness label ("Updated today, HH:MM" /
  // "yesterday" / "on DD.MM."), matching the briefing + per-metric cards so the
  // hero no longer reads relative while the cards below it read absolute. The
  // day boundary follows the user's profile timezone.
  const generatedLine = updatedAt
    ? formatUpdatedLabel(updatedAt, t, fmt.dateShort, fmt.time, displayTz)
    : null;

  return (
    <div
      data-slot="insights-hero-strip"
      className={cn(
        "hero-gradient glow-purple animate-insight-in",
        // `isolate` creates a new stacking context so the purple glow
        // box-shadow stays z-trapped inside the hero band — without
        // it the shadow bled through the sticky section nav below
        // (the nav uses bg-background/80 + backdrop-blur, which the
        // shadow leaked through).
        "relative isolate overflow-hidden rounded-xl px-4 py-4 md:px-6 md:py-6",
      )}
    >
      {/*
       * v1.4.20 phase B5 — split layout. On `md+` (v1.4.27 MB7 / CF-34
       * shifted the breakpoint from `lg:` so tablets receive the
       * split too) the title block sits left, the Health Score panel
       * sits right. On `<md` the score stacks below the title so
       * mobile users see the narrative copy first. When `healthScore`
       * is null/undefined the right column collapses and the title
       * block uses the full width — same shape as B1–B4. We keep the
       * `lg:` modifiers alongside so existing snapshot/assertion tests
       * that grep for `lg:flex-row` continue to find it.
       */}
      {/*
       * v1.4.28 R3c-Insights — switch the row's cross-axis alignment
       * from `items-start` to `items-stretch` so the right-column
       * HealthScore card grows to match the left column's natural
       * height (greeting + subtitle + baseline meta + action row +
       * suggested-prompts strip). Per Inv-4 the card was painting
       * 75-110 px shorter than the left column on desktop; the
       * stretch contract pulls the card's bottom edge down to the
       * "Wirkt mein Medikament?" chip. The card itself owns
       * `h-full` + `mt-auto` on its disclaimer to redistribute the
       * recovered space without visual jank.
       */}
      {/* v1.16.8 — the split keys on `reserveScoreColumn`, not on the
          resolved payload alone: while the analytics query is in flight
          the right column already holds the score card's footprint (the
          skeleton below), so the band's two-column geometry is stable
          from first paint. */}
      <div
        className={cn(
          "flex flex-col gap-4",
          (healthScore || healthScorePending) &&
            "md:flex-row md:items-stretch md:gap-6 lg:flex-row lg:items-stretch lg:gap-6",
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              {/* Header glyph stays in the foreground tier — UI-STANDARDS §1
                  reserves primary/accent for actions, not decorative header
                  icons. */}
              <Sparkles
                className="text-foreground h-5 w-5 shrink-0"
                aria-hidden="true"
              />
              <h1
                data-slot="insights-hero-strip-greeting"
                className="text-2xl leading-tight font-bold tracking-tight sm:text-3xl"
              >
                {greeting}
              </h1>
            </div>
            {/* v1.22 (W6) — the briefing paragraph renders through ProseBlocks
                so a multi-paragraph verdict-first briefing shows real paragraph
                spacing (still plain text children, no markdown). */}
            <div
              data-slot="insights-hero-strip-subtitle"
              className="text-foreground max-w-3xl text-sm"
            >
              <ProseBlocks text={subtitle} />
            </div>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span data-slot="insights-hero-strip-baseline">
                {t("insights.heroPersonalBaseline")}
              </span>
              {generatedLine && (
                <>
                  <span aria-hidden="true" className="opacity-50">
                    ·
                  </span>
                  <span data-slot="insights-hero-strip-generated">
                    {generatedLine}
                  </span>
                </>
              )}
              {/* v1.18.9 (#4) — the subtitle is a cached briefing that can
                  never refresh (no AI provider). Append a discreet hint +
                  Settings → AI link so the relative age above reads as
                  intentionally held, consistent with the briefing card. */}
              {noProviderStale && (
                <>
                  <span aria-hidden="true" className="opacity-50">
                    ·
                  </span>
                  <span
                    data-slot="insights-hero-strip-stale-no-provider"
                    className="inline-flex flex-wrap items-center gap-x-1.5"
                  >
                    <span>
                      {t("insights.dailyBriefing.staleNoProviderHint")}
                    </span>
                    <Link
                      href="/settings/ai"
                      data-slot="insights-hero-strip-stale-no-provider-link"
                      className="text-foreground/80 hover:text-foreground underline underline-offset-2"
                    >
                      {t("insights.dailyBriefing.noProviderAction")}
                    </Link>
                  </span>
                </>
              )}
            </div>
          </div>

          {/*
           * v1.18.7 — the overview "Ask the coach" action row + the
           * guided-questions chip strip were removed from the hero band.
           * The Coach is the bottom-right drawer (mounted in the insights
           * layout shell); the overview leads with the present-focused
           * daily briefing, not a coach prompt. The drawer itself is
           * untouched — only the hero entry points are gone, so the band
           * is now greeting + subtitle + baseline meta.
           */}
        </div>

        {!healthScore && healthScorePending && (
          /* v1.16.8 — layout-stable placeholder mirroring the score
             card's column footprint (same basis / stretch classes as
             `<HealthScoreCard>`): label row, headline number, progress
             bar, four component rows. Decorative — the card announces
             nothing while loading. */
          <div
            data-slot="health-score-card-skeleton"
            aria-hidden="true"
            className={cn(
              "bg-card/65 border-border/60 rounded-xl border p-4 shadow-sm backdrop-blur-sm md:p-6",
              "w-full md:shrink-0 md:grow-0 md:basis-[22rem] xl:basis-[26rem]",
              "flex h-full min-h-64 flex-col gap-3.5",
            )}
          >
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-12 w-28" />
            <Skeleton className="h-2 w-full rounded-full" />
            <Skeleton className="h-3 w-32" />
            <div className="space-y-2.5 border-t pt-3.5">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
            </div>
          </div>
        )}
        {healthScore && (
          <HealthScoreCard
            report={healthScore}
            tension={tensionProp}
            returnToBand={returnToBandProp}
            compact
            className="w-full md:shrink-0 md:grow-0 md:basis-[22rem] xl:basis-[26rem]"
          />
        )}
      </div>
    </div>
  );
}
