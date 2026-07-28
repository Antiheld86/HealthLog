"use client";

import {
  CheckCircle2,
  AlertTriangle,
  CircleSlash,
  Clock,
  Info,
  PauseCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * v1.4.19 phase A5 — single status pill rendered top-right of every
 * integration card (Withings, Mood Log, Apple Health…). It replaces
 * the three- to four-fold redundant status surface the maintainer spotted in
 * v1.4.18:
 *
 *   - top-right "Connected" badge
 *   - middle container with "Connected / last successful / last attempt"
 *   - bottom-of-card "letzter Sync" line
 *
 * Now there is exactly ONE place a sync status can appear on a card
 * and it follows the pattern the maintainer liked from the Withings header: a
 * Dracula-tokenized chip with the relative time inline.
 *
 * The component is locale-aware (EN + DE) and mobile-safe: on a
 * Pixel-5 viewport (393 CSS px) the pill stays on the same line as
 * the card title because it whitespace-nowraps and tucks the icon +
 * abbreviated time form into a 12 char string at most.
 */

/**
 * Pill states — a thin projection of the server's sync-health verdict.
 *
 *   - connected      → happy path; relative "last sync" suffix is shown.
 *   - stale          → connected, but no new data for a while; suffix shown.
 *   - stalled        → the sync stopped even attempting; suffix shown.
 *   - warning        → attempting and failing (a 5xx, a rate limit, an upstream
 *                      contract mismatch). Not the user's to fix.
 *   - error          → reauth-required; "Error — reconnect" copy.
 *   - parked         → >24h of persistent failures put the integration to
 *                      sleep; "Paused — reconnect manually" copy + resume CTA.
 *   - pending-setup  → configured but nothing has arrived yet.
 *   - disconnected   → user clicked Disconnect; "Not connected" copy.
 *
 * **Red is reserved for "your action fixes this".** A transient upstream
 * failure carries the warning tone, not the destructive one: telling a user to
 * reconnect cannot help against a 503, and ten fruitless reconnect clicks are
 * the cost of saying otherwise.
 */
export type IntegrationPillState =
  | "connected"
  | "stale"
  | "stalled"
  | "warning"
  | "error"
  | "parked"
  | "pending-setup"
  | "disconnected";

interface IntegrationStatusPillProps {
  state: IntegrationPillState;
  /** When connected, the last-successful-sync timestamp drives the
   *  relative "12 min ago" suffix. Pass `null` to suppress the
   *  suffix (used when the integration was just configured but has
   *  never synced yet). */
  lastSyncAt: Date | string | null;
  /** Current consecutive-failure count from the active server bucket. */
  failureCount?: number;
  /** Server-owned alert threshold paired with `failureCount`. */
  failureThreshold?: number;
  /** Override "now" for deterministic testing. Defaults to `new Date()`. */
  now?: Date;
  /** Override the testid so a card can keep its own established e2e hook. */
  testId?: string;
  className?: string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Translate a millisecond delta into a short, locale-aware relative
 * string. We keep the buckets small and fixed (just-now / minutes /
 * hours / days) because the pill must fit on a 360 px wide card.
 */
export function formatRelative(
  deltaMs: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (deltaMs < 60_000) return t("settings.integrationPill.justNow");
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) {
    return t("settings.integrationPill.minutesAgo", { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t("settings.integrationPill.hoursAgo", { count: hours });
  }
  const days = Math.floor(hours / 24);
  return t("settings.integrationPill.daysAgo", { count: days });
}

/** The states that paint the semantic warning chip rather than a variant. */
const WARNING_STATES = new Set<IntegrationPillState>([
  "stale",
  "stalled",
  "warning",
  "parked",
]);

/**
 * The states whose label carries an inline relative timestamp.
 *
 * `warning` is in the set because leaving it out was the whole lie: the pill
 * said "sync issue" identically on hour one and on day seventeen, and the age
 * — which the mapper computes and passes in — was dropped on the floor. How
 * long it has been broken is the only part of that sentence a person can act
 * on.
 */
const RELATIVE_STATES = new Set<IntegrationPillState>([
  "connected",
  "stale",
  "stalled",
  "warning",
]);

export function IntegrationStatusPill({
  state,
  lastSyncAt,
  failureCount,
  failureThreshold,
  now,
  testId,
  className,
}: IntegrationStatusPillProps) {
  const { t } = useTranslations();

  // The chip classes apply to `connected` and to every warning-tone state —
  // `error` falls back to `variant="destructive"`, `disconnected` and
  // `pending-setup` to `variant="outline"`. The warning tone is an AA-safe
  // amber that clears contrast in light mode; the distinct labels + icons
  // carry which flavour of "not right" this is.
  const connectedChipClass = "border-success/30 bg-success/15 text-success";
  const warningChipClass = "border-warning/30 bg-warning/15 text-warning";

  let label: string;
  let icon: React.ReactNode;

  switch (state) {
    case "connected":
      label = t("settings.integrationPill.connected");
      icon = <CheckCircle2 aria-hidden="true" className="h-3 w-3" />;
      break;
    case "stale":
      label = t("settings.integrationPill.stale");
      icon = <AlertTriangle aria-hidden="true" className="h-3 w-3" />;
      break;
    case "stalled":
      label = t("settings.integrationPill.stalled");
      icon = <Clock aria-hidden="true" className="h-3 w-3" />;
      break;
    case "warning":
      label = t("settings.integrationPill.warningServerError");
      icon = <AlertTriangle aria-hidden="true" className="h-3 w-3" />;
      break;
    case "error":
      label = t("settings.integrationPill.errorReconnect");
      icon = <AlertTriangle aria-hidden="true" className="h-3 w-3" />;
      break;
    case "parked":
      label = t("settings.integrationPill.parkedReconnect");
      icon = <PauseCircle aria-hidden="true" className="h-3 w-3" />;
      break;
    case "pending-setup":
      label = t("settings.integrationPill.pendingSetup");
      icon = <Info aria-hidden="true" className="h-3 w-3" />;
      break;
    case "disconnected":
      label = t("settings.integrationPill.notConnected");
      icon = <CircleSlash aria-hidden="true" className="h-3 w-3" />;
      break;
  }

  const reference = now ?? new Date();
  const relative =
    RELATIVE_STATES.has(state) && lastSyncAt
      ? formatRelative(
          Math.max(0, reference.getTime() - toDate(lastSyncAt).getTime()),
          t,
        )
      : null;
  const failureRatio =
    failureCount !== undefined &&
    failureCount > 0 &&
    failureThreshold !== undefined
      ? t("settings.integrationPill.failureCount", {
          count: failureCount,
          threshold: failureThreshold,
        })
      : null;

  return (
    <Badge
      data-testid={testId ?? "integration-status-pill"}
      data-state={state}
      variant={
        state === "connected" || WARNING_STATES.has(state)
          ? undefined
          : state === "error"
            ? "destructive"
            : "outline"
      }
      // No `aria-label` here. One used to sit on the badge and, being a
      // generic string, it REPLACED the accessible name with itself — a screen
      // reader announced the same words for "connected · 4 minutes ago" as for
      // "error", which is the one distinction the pill exists to make. The
      // visible label is the accessible name; the relative time stays
      // `aria-hidden` because it is decoration on top of a state that already
      // reads.
      className={cn(
        "max-w-full whitespace-nowrap",
        state === "connected" && connectedChipClass,
        WARNING_STATES.has(state) && warningChipClass,
        className,
      )}
    >
      {icon}
      <span className="truncate">
        {label}
        {failureRatio ? ` · ${failureRatio}` : null}
        {relative ? <span aria-hidden="true"> · {relative}</span> : null}
      </span>
      {relative ? <span className="sr-only">{relative}</span> : null}
    </Badge>
  );
}
