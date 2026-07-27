"use client";

/**
 * S2 — the Today hero, the promoted day's read on the dashboard.
 *
 * MARC SIGN-OFF (2026-07-16, decision 1): Today is the dashboard hero
 * promoted to the default read, with the dense tile grid demoted below
 * it on the SAME page — no new nav destination. This band mounts above
 * the existing tile strip and renders the S1 `DailyDigest` DTO verbatim;
 * it recomputes nothing (server-authoritative parity) and fetches no
 * fresh AI (the caller's hook GETs the already-cached digest route).
 *
 * Composition (plan §2.1, top→bottom, all shipped primitives):
 *   - the day's read: the health `ScoreRing` (`flat`, md) with its
 *     server-computed band and an honest provisional/final face — a null
 *     score paints the ring's own provisional state, never a zero;
 *   - v1.29.1 (Marc, live-use): the v1.29.0 selected-score-ring cluster is
 *     removed from the web hero — it read as uneven and wasted tile space.
 *     The health `ScoreRing` is the hero's only ring now. The score-ring
 *     SELECTION contract stays server-side (`selectedScoreRings` on the
 *     snapshot still feeds iOS); the web hero simply stops rendering it;
 *   - the briefing lead in plain language (via `ProseBlocks`, no markdown)
 *     with a "read the full briefing" affordance, plus the top signal's
 *     present-tense headline + delta when the digest carries one;
 *   - the freshness note: when `sleepPending`, a calm muted "last night's
 *     sleep not yet in" line — it never blocks the hero (plan §2.4);
 *   - the worth-a-look rail: the digest's `PriorityItem[]` as `PriorityCard`s
 *     (S1's one rail primitive), only when non-empty. When the digest is
 *     all-clear, a first-class muted "nothing needs your attention" line
 *     stands in its place — not an alarming empty card.
 *
 * Every `PriorityItem` action carries an `href` (dose.log → /medications,
 * sync.reconnect → /settings/integrations, checkup.view → /checkups), so
 * `PriorityCard` wires each tap as a `<Link>` to its existing destination
 * by construction; S2 invents no new backend action.
 */
import Link from "next/link";
import { Moon } from "lucide-react";

import { useMounted } from "@/hooks/use-mounted";
import { formatTime } from "@/lib/format";
import { ScoreRing } from "@/components/insights/derived/score-ring";
import type { ScoreBand } from "@/components/insights/derived/band-tokens";
import { ProseBlocks } from "@/components/insights/prose-blocks";
import { PriorityCard } from "@/components/daily/priority-card";
import { useCoachCheckinAction } from "@/hooks/use-coach-checkin";
import { usePriorityItemDismiss } from "@/hooks/use-priority-item-dismiss";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { DailyDigest } from "@/lib/daily/digest";
import {
  COACH_CHECKIN_KEEP_INTENT,
  COACH_CHECKIN_LETGO_INTENT,
} from "@/lib/daily/coach-checkin-intents";

/** Format the server-computed score delta as a signed, muted chip string. */
function formatDelta(
  delta: number,
  t: ReturnType<typeof useTranslations>["t"],
) {
  const rounded = Math.round(delta);
  if (rounded === 0) return t("daily.today.deltaFlat");
  const signed = rounded > 0 ? `+${rounded}` : `${rounded}`;
  return t("daily.today.deltaVsBaseline", { delta: signed });
}

/**
 * The "just in" chip's clock face.
 *
 * Formatted CLIENT-side, and only after mount. `justIn.at` crosses the wire as
 * an ISO instant precisely so this stays a client concern: the server has no
 * business rendering a local wall-clock time it would format under its OWN
 * locale and timezone, and any such string would differ from the browser's on
 * the hydration render — React #418, a class of bug this project has already
 * paid for once.
 *
 * Goes through the shared `formatTime`, which reads the profile's timezone and
 * clock preference. The bare `toLocaleTimeString(undefined, …)` this replaces
 * asked the BROWSER instead, which is a different question: someone whose
 * profile says Europe/Berlin while their laptop sits in Manila saw a Manila
 * time here and a Berlin time on every other surface, for the same instant.
 */
function formatJustInTime(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  try {
    return formatTime(at);
  } catch {
    return null;
  }
}

export function TodayHero({ digest }: { digest: DailyDigest }) {
  const { t } = useTranslations();
  // Gates ONLY the chip's time string — never the chip's presence. The hero
  // itself is deliberately NOT mount-gated (v1.30.9: it is the LCP element and
  // paints from the server-dehydrated digest on both the SSR and the hydration
  // render). So the slot renders on both passes and the formatted time fills in
  // on the first client re-render, keeping those two passes byte-identical.
  const mounted = useMounted();
  const { keep, letGo } = useCoachCheckinAction();
  const dismissItem = usePriorityItemDismiss();

  // The coach check-in card's keep / let-go intents carry the plan id after the
  // ":" (a closed two-intent allowlist); adjust is an href handled by the card
  // as a <Link>, so it never lands here. Every other rail kind is pure
  // navigation (dose / sync / preventive), so their taps never call this.
  const handleAction = (intent: string) => {
    const keepPrefix = `${COACH_CHECKIN_KEEP_INTENT}:`;
    const letGoPrefix = `${COACH_CHECKIN_LETGO_INTENT}:`;
    if (intent.startsWith(keepPrefix)) {
      keep.mutate(intent.slice(keepPrefix.length));
    } else if (intent.startsWith(letGoPrefix)) {
      letGo.mutate(intent.slice(letGoPrefix.length));
    }
  };

  const hasScore = digest.score !== null;
  const hasItems = digest.worthALook.length > 0;
  // Lead precedence, warmest first: the day's reaction line REPLACES the
  // briefing lead once something landed — it never appends as a second
  // paragraph, so the hero stays exactly one lead line tall and nothing below
  // it shifts. The briefing lead is the standing read; the deterministic
  // `line` is the floor a keyless self-hoster still gets.
  const lead = digest.reactionLine ?? digest.briefingLead ?? digest.line;
  const topSignal = digest.topSignal;
  const justInTime = digest.justIn ? formatJustInTime(digest.justIn.at) : null;

  // Calm degrade (plan §3): a genuinely empty account — no score, no rail
  // items, no cached briefing lead, and no fresh arrival — surfaces nothing
  // here. The tile strip below carries its own "add your first reading" empty
  // state, so a second alarming empty card on the hero would be noise. The
  // all-clear state (score present, nothing needs attention) is handled inline
  // below. A fresh marker counts as content even when line generation was
  // unavailable: the deterministic digest line still gives the hero an honest
  // lead, and hiding the marker would lose the arrival moment entirely.
  if (
    !hasScore &&
    !hasItems &&
    !digest.briefingLead &&
    !digest.reactionLine &&
    !digest.justIn
  ) {
    return null;
  }

  return (
    <section
      data-slot="today-hero"
      data-phase={digest.phase}
      className={cn(
        // The tile strip's surface plus the ONE sanctioned Today atmosphere:
        // `.today-hero-wash` leans a faint `--primary` mix over the theme
        // `--card` toward the ring corner (the `.wellness-tile` color-mix
        // pattern, softer than the insights hero) so the promoted day's read
        // carries a quiet identity without a banner gradient or glow.
        "bg-card today-hero-wash border-border relative isolate overflow-hidden rounded-xl border",
        "p-4 md:p-6",
      )}
    >
      {/* v1.29.1 — tightened after the v1.29.0 ring cluster was removed: the
          hero read as half-empty (short lead → gap → rail). Compact section
          gaps let the worth-a-look rail sit close under the lead so the card
          reads filled, not padded out. */}
      <div className="flex flex-col gap-3 md:gap-4">
        {/* The day's read — the numeric face on the trailing edge, the
            narrative lead leading. On md+ the lead sits flush-top with the
            score ring (items-start) rather than floating centred beside it. */}
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between md:gap-6">
          <div className="min-w-0 flex-1 space-y-2">
            {/* Hero numeric face: the read leads large in the foreground
                token, calm and legible — the day's read, not a slogan. */}
            <div
              data-slot="today-hero-lead"
              className="text-foreground text-lg leading-snug font-semibold tracking-tight sm:text-xl"
            >
              <ProseBlocks text={lead} strip linkify={false} />
            </div>
            {/* Top signal — present-tense headline + optional delta, one
                muted step down so it supports the lead without competing. */}
            {topSignal ? (
              <p
                data-slot="today-hero-signal"
                className="text-muted-foreground text-sm"
              >
                {topSignal.headline}
                {topSignal.delta ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {topSignal.delta}
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>

          {/* Health score ring — `flat` (no sweep/bloom), server-computed
              band. A null score paints the ring's honest provisional face
              at the same footprint, so the column never collapses. */}
          <div className="flex shrink-0 flex-col items-center gap-1 md:items-end">
            <div data-slot="today-hero-score">
              {/* The ring opens the Insights overview — the destination the
                  health-score card owns — matching the cluster rings' tap
                  behaviour, so every hero ring is a door, not a poster. */}
              <Link
                href="/insights"
                aria-label={t("daily.today.ringLink", {
                  metric: t("daily.today.scoreLabel"),
                })}
                className="focus-visible:ring-ring/50 block rounded-full focus-visible:ring-2 focus-visible:outline-none"
              >
                <ScoreRing
                  score={digest.score?.value ?? null}
                  band={
                    digest.score ? (digest.score.band as ScoreBand) : undefined
                  }
                  size="md"
                  flat
                  label={t("daily.today.scoreLabel")}
                />
              </Link>
            </div>
            {digest.score && digest.score.delta !== null ? (
              <span
                data-slot="today-hero-score-delta"
                className="text-muted-foreground text-xs tabular-nums"
              >
                {formatDelta(digest.score.delta, t)}
              </span>
            ) : null}
          </div>
        </div>

        {/* Meta row — the hero's quiet tier (UI-STANDARDS §text: `text-xs
            text-muted-foreground` is the meta floor; never an accent, never an
            opacity modifier). Holds the freshness note and the "just in" chip;
            they can legitimately co-occur (a weight landed while last night's
            sleep is still pending), so they share one wrapping row rather than
            competing for the same slot. */}
        {digest.sleepPending || digest.justIn ? (
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {/* Freshness note (plan §2.4) — provisional day, last night's
                sleep not yet folded in. Muted, non-blocking, refreshes in
                place when the morning job lands. */}
            {digest.sleepPending ? (
              <p
                data-slot="today-hero-sleep-pending"
                className="flex items-center gap-1.5"
              >
                <Moon className="size-3.5 shrink-0" aria-hidden="true" />
                {t("daily.today.sleepPending")}
              </p>
            ) : null}

            {/* The "just in" chip — a state change, not a notification. No
                badge count, no accent, no animation: the record simply reads
                differently on the next refresh, and this names why. It is
                present for as long as the arrival is news (the server applies
                the window, so the chip expires on a poll rather than on a
                client timer) and carries the arrival's local time once the
                client has mounted and can format it honestly. */}
            {digest.justIn ? (
              <p
                data-slot="today-hero-just-in"
                data-just-in-kind={digest.justIn.kind}
                className="flex items-center gap-1.5"
              >
                {mounted && justInTime
                  ? t("daily.today.justInAt", { time: justInTime })
                  : t("daily.today.justIn")}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Worth-a-look rail — S1's `PriorityCard`s, bounded 0–3. When the
            digest is all-clear, a first-class muted line stands in for the
            rail (calm inversion of an alarm), never an empty card. */}
        {hasItems ? (
          <div className="space-y-2" data-slot="today-hero-rail">
            <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t("daily.today.worthALook")}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {digest.worthALook.map((item, i) => (
                <PriorityCard
                  key={`${item.kind}-${i}`}
                  item={item}
                  onAction={handleAction}
                  onDismiss={(itemKey) => dismissItem.mutate(itemKey)}
                  actionsPending={
                    item.kind === "coach_checkin" &&
                    (keep.isPending || letGo.isPending)
                  }
                />
              ))}
            </div>
          </div>
        ) : (
          <p
            data-slot="today-hero-all-clear"
            className="text-muted-foreground text-sm"
          >
            {t("daily.today.allClear")}
          </p>
        )}
      </div>
    </section>
  );
}
