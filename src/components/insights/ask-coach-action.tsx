"use client";

import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import {
  useCoachLaunch,
  type CoachLaunchScope,
} from "@/lib/insights/coach-launch-context";
import { useAiCapability } from "@/hooks/use-ai-capability";

/**
 * v1.21.0 (C4 H2) — discreet "Ask the Coach about this" affordance for
 * high-value insight / assessment cards (briefing, recommendation,
 * correlation, status, health-score, period narrative).
 *
 * It is the reverse-direction entry point the C4 audit flagged as
 * missing: the cards carry the richest context in the app, so a single
 * small action per card opens the Coach pre-scoped to that card's topic
 * with a seeded opener. Reuses the existing launch context — no parallel
 * launch system.
 *
 * Subtle by construction: a ghost, muted-foreground text+icon button (no
 * alarming colour, no card-tinting — the medication-card rule holds). One
 * entry point per card, never a cluster.
 *
 * Self-gates on the same triple the FAB / inline pill use (provider
 * mounted + operator flag + per-user opt-out) so a card never paints a
 * dead Coach control.
 */
export interface AskCoachActionProps {
  /**
   * Composer seed question — a plain-English opener about the card's
   * topic. The Coach treats it as composer seed text, not an i18n key
   * (the chat route is EN/DE-gated), matching the empty-state convention.
   */
  question: string;
  /**
   * Optional scope so the conversation narrows to the card's source(s).
   * Omitted for cards that span the whole picture (e.g. the daily
   * briefing), which read better against the default all-source snapshot.
   */
  scope?: CoachLaunchScope;
  /**
   * Auto-send the seeded question as the conversation's first turn instead
   * of only seeding the composer. The assessment hand-off sets this so the
   * Coach answers immediately; defaults to false (seed-only).
   */
  autoSend?: boolean;
  /** Optional visible-label override; defaults to the shared CTA copy. */
  label?: string;
  /** className passthrough for per-card alignment. */
  className?: string;
}

export function AskCoachAction({
  question,
  scope,
  autoSend,
  label,
  className,
}: AskCoachActionProps) {
  const { t } = useTranslations();
  const launch = useCoachLaunch();
  const coach = useAiCapability("coach");

  // Same gate posture as <CoachLaunchButton> / <LayoutCoachFab>: render
  // nothing unless the launch provider is mounted and the `coach`
  // capability is available.
  if (!launch) return null;
  if (!coach.available) return null;

  const accessibleLabel = label ?? t("insights.coach.askAboutThis");

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-slot="ask-coach-action"
      onClick={() => launch.askCoach(question, scope, autoSend)}
      className={cn(
        // Discreet: muted text, hover lifts to foreground, no fill. Tight
        // height so it sits as a quiet footer link, not a primary CTA.
        "text-muted-foreground hover:text-foreground h-8 gap-1.5 px-2 text-xs",
        className,
      )}
    >
      <Sparkles className="size-3.5" aria-hidden="true" />
      <span>{accessibleLabel}</span>
    </Button>
  );
}

/**
 * v1.25 — icon-only Coach hand-off pinned to the TOP-RIGHT of an assessment
 * card header. Same launch + gating contract as `<AskCoachAction>`, but no
 * visible text label: the affordance is a single ghost icon button with an
 * accessible name and a tooltip carrying the same copy (a11y — an icon button
 * must announce its purpose).
 *
 * Self-gates on the same triple every Coach entry point uses (provider mounted
 * in the tree + operator flag + per-user opt-out), so the card never paints a
 * dead control. The assessment card only mounts it on the populated branch,
 * where the provider is known good — the "no advertised-but-broken control"
 * rule holds end-to-end.
 */
export function AskCoachIconButton({
  question,
  scope,
  autoSend,
  label,
  className,
}: AskCoachActionProps) {
  const { t } = useTranslations();
  const launch = useCoachLaunch();
  const coach = useAiCapability("coach");

  if (!launch) return null;
  if (!coach.available) return null;

  const accessibleLabel = label ?? t("insights.coach.askAboutThis");

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-slot="ask-coach-icon"
            aria-label={accessibleLabel}
            onClick={() => launch.askCoach(question, scope, autoSend)}
            className={cn(
              // Keep the quiet 32px visual on pointer surfaces, but grow the
              // tap target to the WCAG 2.5.5 44px floor on touch (the ghost has
              // no fill, so the larger hit box is invisible). Matches the
              // header-action convention on the biomarker detail page.
              "text-muted-foreground hover:text-foreground min-h-11 min-w-11 sm:size-8",
              className,
            )}
          >
            <Sparkles className="size-4" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{accessibleLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
