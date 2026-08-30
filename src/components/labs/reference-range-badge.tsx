"use client";

import { ArrowDown, ArrowUp, Minus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/lib/i18n/context";
import type { ReferenceRangeStatus } from "@/lib/validations/labs";

/**
 * v1.17.1 — reference-range badge.
 *
 * Renders the server-computed `rangeStatus` as a calm, informative marker.
 * The project's no-alarming-colour ethos is a hard rule here: an
 * out-of-range value is NOT painted red. It reads as a neutral `secondary`
 * badge with a quiet direction arrow (↓ below / ↑ above), exactly the same
 * weight as the in-range and unknown states. The number leaving the
 * reference window is information a clinician scans — not an alarm to the
 * user, who may be perfectly aware of (and managing) the value.
 *
 * `unknown` (the lab reported no usable bounds) renders nothing — there is
 * no verdict to show, and an empty badge would be noise.
 */
export function ReferenceRangeBadge({
  status,
  compact = false,
}: {
  status: ReferenceRangeStatus;
  /**
   * v1.18.10 (#4) — a quieter, smaller treatment for the labs overview, where
   * the badge sits beside the analyte heading and must not compete with it.
   * The hero/detail view keeps the default (un-compact) size.
   */
  compact?: boolean;
}) {
  const { t } = useTranslations();

  if (status === "unknown") return null;

  // Compact: drop the icon, shrink the text and padding so the badge reads as a
  // subtle qualifier of the heading rather than a second focal point.
  const compactClass = compact
    ? "h-auto gap-0.5 px-1.5 py-0 text-xs font-normal [&>svg]:size-2.5"
    : "";

  if (status === "in-range") {
    return (
      <Badge
        variant="outline"
        className={`text-muted-foreground ${compactClass}`.trim()}
      >
        {compact ? null : <Minus aria-hidden />}
        {t("labs.range.inRange")}
      </Badge>
    );
  }

  // Below / above use a restrained semantic tint, distinguished by the
  // arrow direction and label rather than an alarm treatment.
  const Icon = status === "below" ? ArrowDown : ArrowUp;
  const label =
    status === "below" ? t("labs.range.below") : t("labs.range.above");
  const toneClass =
    status === "below"
      ? "border-info/30 bg-info/10 text-info"
      : "border-warning/30 bg-warning/10 text-warning";
  return (
    <Badge variant="outline" className={`${toneClass} ${compactClass}`.trim()}>
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}
