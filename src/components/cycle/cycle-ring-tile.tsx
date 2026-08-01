"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Droplets } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { CycleRing } from "./cycle-ring";
import { PHASE_HUE } from "./phase-tokens";
import { localYmd, useCycleCalendar } from "./use-cycle";

/**
 * v1.15.3 — the compact cycle ring as a WELLNESS-STRIP element.
 *
 * A same-size sibling tile that drops into the main Insights "Your health
 * scores" grid (`<WellnessScores>`), so the cycle phase reads as part of the
 * premium scores strip rather than bolted-on below it. It reuses the SAME
 * `<CycleRing>` SVG the cycle page wheel uses, sized down to match a
 * `ScoreRing size="sm"` (≈120 px) so the dial sits in the strip's tile
 * rhythm; the tile chrome (hue-tinted `wellness-tile`, icon header, once-per-
 * session reveal) mirrors the score `RingTile` exactly.
 *
 * It is NOT a second `<CycleInsightSummaryCard>` — that teaser (phase finding +
 * deep-link) already lives further down the overview. This is the RING only,
 * as a wellness dial. Both surfaces read day-of-cycle + phase from the SAME
 * server-resolved `verdict` on the calendar read, so they can never disagree —
 * and neither of them computes it.
 *
 * GATING IS THE CALLER'S JOB. The page mounts this only when
 * `user.cycleTrackingEnabled` is true (the same `/api/auth/me` signal the
 * sidebar-nav entry + the summary card gate on), so the cycle read never fires
 * for an account without the feature. The tile additionally renders nothing
 * while the calendar read resolves, on a hard error, and when there is no
 * active cycle phase today — never an empty-framed or half-painted dial in the
 * strip (no gap, no placeholder).
 */

/** YYYY-MM-DD for `n` days from now in the local tz (shares `localYmd`). */
function shiftToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localYmd(d);
}

export function CycleRingTile({ className }: { className?: string }) {
  const { t } = useTranslations();

  // Mirror the cycle-view + summary-card window so the cache key is shared —
  // no extra request when the user opens the cycle page in the same session.
  const from = useMemo(() => shiftToday(-90), []);
  const to = useMemo(() => shiftToday(180), []);

  const calendar = useCycleCalendar(from, to);
  // The server already resolved the ring: cycle day, phase, and the arc
  // proportions (including the profile-derived idealized ring a low-data
  // tracker gets). The tile renders it.
  const verdict = calendar.data?.verdict;

  // The signature reveal plays ONCE per browser session, gated on its own key
  // so a background calendar refetch never re-triggers the moment. The
  // reduced-motion zeroing lives inside `<CycleRing>`.
  const [play] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      if (sessionStorage.getItem("cycle-strip-ring-revealed")) return false;
      sessionStorage.setItem("cycle-strip-ring-revealed", "1");
      return true;
    } catch {
      return true;
    }
  });

  // Stay silent until the read resolves, on a hard error, and when today has
  // no phase (no active cycle) — the strip must never show a half-painted or
  // empty-framed cycle dial. The full cycle page owns the empty-state CTA.
  if (calendar.isLoading && !calendar.data) return null;
  if (calendar.isError && !calendar.data) return null;
  if (verdict?.phase == null || verdict.dayOfCycle == null) return null;

  const hue = PHASE_HUE[verdict.phase];

  return (
    // `data-revealed` must sit on an ANCESTOR of `.wellness-tile-rise` — the
    // keyframe selector is `[data-revealed="true"] .wellness-tile-rise`
    // (descendant combinator). Both on the same node never matched, leaving the
    // tile stuck at the rise rule's `opacity: 0`. The `contents` wrapper carries
    // the flag without adding a layout box.
    <div data-revealed={play ? "true" : undefined} className="contents">
      <Link
        href="/cycle"
        data-slot="wellness-cycle-tile"
        data-metric="CYCLE"
        data-phase={verdict.phase}
        // Match the score `RingTile` chrome: the phase's `--tile-hue`
        // low-opacity mix over `--card` + the faint film grain (the
        // `.wellness-tile` family), with a calm once-per-session rise. The
        // per-phase hue arc inside the ring is the only saturated thing.
        style={{ "--tile-hue": hue } as React.CSSProperties}
        className={cn(
          "wellness-tile focus-visible:ring-ring flex flex-col gap-4 rounded-xl p-4 focus-visible:ring-2 focus-visible:outline-none md:p-6",
          play && "wellness-tile-rise",
          className,
        )}
      >
        <div className="text-foreground flex items-center gap-2">
          <Droplets className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span className="truncate text-base leading-none font-semibold">
            {t("cycle.wellnessRing.label")}
          </span>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <CycleRing
            dayOfCycle={verdict.dayOfCycle}
            cycleLength={verdict.cycleLength}
            phase={verdict.phase}
            spans={verdict.spans}
            animate={play}
            size={120}
          />
          <span
            data-slot="wellness-cycle-band-word"
            className="text-muted-foreground text-center text-xs"
          >
            {t(`cycle.phase.${verdict.phase}`)}
          </span>
        </div>
      </Link>
    </div>
  );
}
