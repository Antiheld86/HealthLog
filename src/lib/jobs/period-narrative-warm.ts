/**
 * v1.11.0 W3 — nightly period-narrative warm cron + single-user dispatch.
 *
 * The nightly tick warms the latest week/month narrative for data-bearing,
 * coach-enabled users so the Insights overview renders the summary instantly
 * the morning after a period boundary, never blocking the first mount on the
 * provider. The handler only fans out near a boundary:
 *   - the WEEK narrative warms on Mondays (the day after a week closes),
 *   - the MONTH narrative warms on the 1st of the month.
 * On every other night it short-circuits to a no-op for cheapness.
 *
 * Budget gate (mirrors `insight-pregenerate`): a per-user rate-limit bucket
 * (`period-narrative:<userId>`, one warm / 20 h) bounds nightly LLM cost, and
 * a per-run batch cap bounds a single tick. Without a provider the generator
 * makes no LLM call — it composes the deterministic, non-causal fallback from
 * the same context instead — and writes nothing on an insufficient context,
 * so a provider-less / sparse account costs only the context build.
 *
 * Recurring pg-boss task — never runs inside an HTTP request, never shells out
 * to `tsx` (CLAUDE.md DO-NOTs).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { checkRateLimit } from "@/lib/rate-limit";
import { getAssistantFlags } from "@/lib/feature-flags";
import {
  mayDispatchProviderWork,
  withProviderWorkAuthority,
} from "@/lib/sharing/provider-work-authority";
import { annotate } from "@/lib/logging/context";
import {
  generatePeriodNarrative,
  type NarrativeGenerateOutcome,
} from "@/lib/insights/narrative/period-narrative-generate";
import type { NarrativePeriod } from "@/lib/insights/narrative/period-narrative";
import { locales, defaultLocale, type Locale } from "@/lib/i18n/config";
import {
  PERIOD_NARRATIVE_QUEUE,
  PERIOD_NARRATIVE_CRON,
  enqueueNarrativeWarm,
  type PeriodNarrativePayload,
} from "@/lib/jobs/period-narrative-shared";

export { PERIOD_NARRATIVE_QUEUE, PERIOD_NARRATIVE_CRON, enqueueNarrativeWarm };
export type { PeriodNarrativePayload };

/** Per-run cap on the number of users a single tick generates for. */
export const NARRATIVE_BATCH_CAP = 200;

/** Per-user budget bucket window — one warm per 20 h. */
const NARRATIVE_BUDGET_WINDOW_MS = 20 * 60 * 60 * 1000;

export interface NarrativeWarmRunResult {
  /** Periods warmed this tick (empty when not on a boundary night). */
  periods: NarrativePeriod[];
  total: number;
  generated: number;
  cached: number;
  skipped: number;
  insufficient: number;
  failed: number;
  budgetBlocked: number;
}

/**
 * Which period narratives a given calendar day should warm. The week
 * narrative warms on Mondays (`getDay() === 1`); the month narrative warms on
 * the 1st. A day can be both (the 1st falling on a Monday). Returns an empty
 * list on a non-boundary day, so the nightly cron is a no-op most nights.
 *
 * Exported + pure so the cron test can pin the boundary logic without a clock.
 */
export function periodsForDay(
  now: Date,
  tz = "Europe/Berlin",
): NarrativePeriod[] {
  // Resolve the local weekday + day-of-month in the maintenance-window tz so
  // the boundary matches the user-facing calendar, not UTC.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const dayOfMonth = Number(parts.find((p) => p.type === "day")?.value);

  const periods: NarrativePeriod[] = [];
  if (weekday === "Mon") periods.push("week");
  if (dayOfMonth === 1) periods.push("month");
  return periods;
}

interface NarrativeCandidate {
  id: string;
  locale: string | null;
}

/**
 * Discovery query — coach-enabled users, oldest-narrative-first so the
 * staleest users are served before the per-run cap bites. Whether a user has
 * a provider / enough history is confirmed inside the generator (skipped /
 * insufficient), so a provider-less or sparse account costs at most one cheap
 * chain-resolve and no LLM call.
 *
 * Ordering needs a second read: `InsightNarrative` keeps one row per
 * (user, period, locale), so the user's most recent narrative write is a
 * per-user `MAX(updated_at)` — never-warmed users (no rows at all) sort
 * first, then the staleest. The aggregate only runs when the cohort
 * actually exceeds the cap; below it every candidate is processed anyway
 * and the order is irrelevant.
 */
export async function findNarrativeCandidates(
  prisma: PrismaClient,
  cap: number,
): Promise<NarrativeCandidate[]> {
  const users: NarrativeCandidate[] = await prisma.user.findMany({
    where: { disableCoach: false },
    select: { id: true, locale: true },
  });
  if (users.length <= cap) return users;

  const latest = await prisma.insightNarrative.groupBy({
    by: ["userId"],
    _max: { updatedAt: true },
  });
  const latestByUser = new Map<string, number>(
    latest.map((row) => [row.userId, row._max.updatedAt?.getTime() ?? 0]),
  );
  return [...users]
    .sort(
      (a, b) => (latestByUser.get(a.id) ?? 0) - (latestByUser.get(b.id) ?? 0),
    )
    .slice(0, cap);
}

/**
 * The user's stored locale, validated against the shipped UI locale union.
 *
 * The narrative row is keyed `(user, period, locale)`, so the nightly warm has
 * to write the SAME key the read route reads. Collapsing fr/es/it/pl to `en`
 * here would leave those users' rows permanently cold on the nightly path.
 * An unset or unknown value falls back to the app default (`en`), never to
 * German.
 */
function normalizeLocale(value: string | null): Locale {
  return locales.includes(value as Locale) ? (value as Locale) : defaultLocale;
}

/**
 * Run one nightly warm pass. Pure of pg-boss so the unit test can drive it
 * directly. Short-circuits to a no-op when (a) the master assistant briefing
 * switch is off or (b) the night is not a period boundary. The per-user
 * budget gate runs BEFORE the LLM call so a no-op night costs only
 * rate-limit upserts.
 */
export async function runPeriodNarrativeWarm(
  prisma: PrismaClient,
  options: {
    now?: Date;
    cap?: number;
    /** Injected for the test — defaults to the real generator. */
    generate?: typeof generatePeriodNarrative;
  } = {},
): Promise<NarrativeWarmRunResult> {
  const now = options.now ?? new Date();
  const cap = options.cap ?? NARRATIVE_BATCH_CAP;
  const generate = options.generate ?? generatePeriodNarrative;

  const result: NarrativeWarmRunResult = {
    periods: [],
    total: 0,
    generated: 0,
    cached: 0,
    skipped: 0,
    insufficient: 0,
    failed: 0,
    budgetBlocked: 0,
  };

  const flags = await getAssistantFlags();
  if (!flags.briefing) return result;

  const periods = periodsForDay(now);
  result.periods = periods;
  if (periods.length === 0) return result;

  const candidates = await findNarrativeCandidates(prisma, cap);
  result.total = candidates.length;

  for (const candidate of candidates) {
    const budget = await checkRateLimit(
      `period-narrative:${candidate.id}`,
      1,
      NARRATIVE_BUDGET_WINDOW_MS,
    );
    if (!budget.allowed) {
      result.budgetBlocked++;
      continue;
    }

    const locale = normalizeLocale(candidate.locale);
    for (const period of periods) {
      const outcome = await generate(candidate.id, {
        period,
        locale,
        force: true,
        now,
      });
      tally(result, outcome);
    }
  }

  annotate({
    action: { name: "insights.narrative.warm.run" },
    meta: {
      periods,
      total: result.total,
      generated: result.generated,
      cached: result.cached,
      skipped: result.skipped,
      insufficient: result.insufficient,
      failed: result.failed,
      budget_blocked: result.budgetBlocked,
    },
  });

  return result;
}

function tally(
  result: NarrativeWarmRunResult,
  outcome: NarrativeGenerateOutcome,
): void {
  switch (outcome.status) {
    case "generated":
      result.generated++;
      break;
    case "cached":
      result.cached++;
      break;
    case "skipped":
      result.skipped++;
      break;
    case "insufficient":
      result.insufficient++;
      break;
    case "failed":
      result.failed++;
      break;
  }
}

/**
 * Single-user warm enqueued by the read-only GET on a cold/stale read. Runs
 * the generator directly for one (user, period, locale) WITHOUT the nightly
 * budget bucket (the enqueue's `singletonKey` is the anti-spam layer). The
 * generator composes the deterministic fallback without a provider and writes
 * nothing on an insufficient context, so this is bounded by construction.
 */
export async function warmOneNarrative(
  payload: PeriodNarrativePayload,
  generate: typeof generatePeriodNarrative = generatePeriodNarrative,
): Promise<NarrativeGenerateOutcome | null> {
  if (!payload.userId || !payload.period) return null;
  const authority = payload.authority;
  if (!authority || !(await mayDispatchProviderWork(authority))) return null;
  const flags = await getAssistantFlags();
  if (!flags.briefing && !flags.insightStatus) return null;
  return withProviderWorkAuthority(authority, () =>
    generate(payload.userId!, {
      period: payload.period!,
      locale: payload.locale ?? defaultLocale,
      force: true,
    }),
  );
}
