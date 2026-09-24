"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { RecoverySection } from "@/components/insights/recovery/recovery-section";

/**
 * v1.17.1 — `/insights/recovery`.
 *
 * The render host for the WHOOP / Polar device-native recovery + strain scores
 * that were stored end-to-end but had no page: day strain, workout strain, ANS
 * charge, cardio load, and the day's whole-cycle average / max heart rate and
 * kilojoule energy expenditure. The composite RECOVERY_SCORE keeps its anatomy
 * detail at `/insights/scores/recovery`.
 *
 * v1.18.1 (B1–B3) — the page now follows the canonical per-metric structure:
 * each present signal renders a block carrying a short explainer, the
 * max / median / mean stat strip, the same chart with the 7 / 30 / 90 / All
 * toggle, and a per-chart assessment. The redundant top "Recovery score"
 * cross-link is removed (reached from the overview already).
 *
 * Every block is data-gated inside `<RecoverySection>`, so an account without a
 * strap / ring sees only the calm empty note. Server-authoritative: the charts
 * render stored values, never a recompute.
 */
export default function InsightsRecoveryPage() {
  const { t } = useTranslations();

  return (
    <SubPageShell
      title={t("insights.recovery.title")}
      description={t("insights.recovery.description")}
      explainerMetric="recoveryPage"
      coachLaunch
    >
      {/* 2026-07-17 UX/IA audit M4 — reverse direction of the cross-link added
          to the score-anatomy page: this composite wearable page shares the
          "Recovery" nav label with the RECOVERY_SCORE anatomy view at
          `/insights/scores/recovery`, so a user who arrived here looking for
          the score ring / contributor breakdown gets a pointer instead of a
          dead end. */}
      <Link
        href="/insights/scores/recovery"
        data-slot="recovery-anatomy-cross-link"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -mt-2 inline-flex items-center gap-1.5 text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
      >
        {t("insights.recovery.scoreCrossLink")}
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </Link>
      <RecoverySection />
    </SubPageShell>
  );
}
