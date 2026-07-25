"use client";

/**
 * Per-metric freshness, rendered.
 *
 * The server has computed a last-seen timestamp per `(source, type)` on every
 * status call since v1.27.30 and nothing rendered it. That is the one signal
 * that separates "the connection is broken" from "one pipe inside a healthy
 * connection is dead" — a revoked HealthKit permission, a per-collection 403,
 * an upstream that quietly stopped returning one data type. The integration
 * pill cannot express it, because the integration itself is fine.
 *
 * Collapsed by default: a Withings or Google Health user carries 15-25 types
 * and an always-open list would bury the card's actions. The collapsed summary
 * still names how many types have gone quiet, so the signal never hides behind
 * a click.
 *
 * Honest absence is structural: the server only reports `(source, type)` pairs
 * that have rows, so a type a provider never delivered simply is not here. No
 * "expected but missing" row is invented.
 */

import { useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";

import { formatRelative } from "@/components/settings/integration-status-pill";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/components/measurements/measurement-list-meta";
import { useTranslations } from "@/lib/i18n/context";
import type { MetricFreshnessEntry } from "@/lib/integrations/sync-verdict";
import { cn } from "@/lib/utils";

/** The pseudo-type carrying a source's newest workout. */
const WORKOUT_TYPE = "WORKOUTS";

/**
 * Turn an unmapped enum name into something readable. `MEASUREMENT_TYPE_LABEL_KEYS`
 * is a plain record, not enum-complete, so a newly-added type must degrade to
 * "Walking asymmetry" rather than leaking `WALKING_ASYMMETRY` at the user.
 */
function humanise(type: string): string {
  const words = type.toLowerCase().split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function MetricFreshnessDisclosure({
  entries,
  idPrefix,
  now,
}: {
  entries: MetricFreshnessEntry[] | undefined;
  /** Namespaces the disclosure's ids so several cards can coexist. */
  idPrefix: string;
  /** Override "now" for deterministic testing. */
  now?: Date;
}) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);

  if (!entries?.length) return null;

  const reference = now ?? new Date();
  const label = (type: string): string => {
    if (type === WORKOUT_TYPE)
      return t("settings.integrationFreshness.workouts");
    const key = MEASUREMENT_TYPE_LABEL_KEYS[type];
    return key ? t(key) : humanise(type);
  };
  const relative = (lastSeenAt: string): string =>
    formatRelative(
      Math.max(0, reference.getTime() - new Date(lastSeenAt).getTime()),
      t,
    );

  // Dead pipes surface without scrolling; everything else stays alphabetical.
  const sorted = [...entries].sort(
    (a, b) =>
      Number(b.stale) - Number(a.stale) ||
      label(a.type).localeCompare(label(b.type)),
  );
  const staleCount = entries.filter((entry) => entry.stale).length;
  const newest = entries.reduce((max, entry) =>
    entry.lastSeenAt > max.lastSeenAt ? entry : max,
  );
  const panelId = `${idPrefix}-metric-freshness-panel`;

  return (
    <div data-slot="metric-freshness" className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        data-slot="metric-freshness-toggle"
        className="flex w-full items-center gap-2 text-left"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "text-muted-foreground size-3.5 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
        <span className="text-sm font-medium">
          {t("settings.integrationFreshness.title")}
        </span>
        <span className="text-muted-foreground min-w-0 truncate text-xs">
          {t("settings.integrationFreshness.summary", {
            count: entries.length,
            relative: relative(newest.lastSeenAt),
          })}
          {staleCount > 0 ? (
            <span className="text-warning">
              {" · "}
              {t("settings.integrationFreshness.quiet", { count: staleCount })}
            </span>
          ) : null}
        </span>
      </button>

      {open && (
        <ul id={panelId} className="space-y-1">
          {sorted.map((entry) => (
            <li
              key={entry.type}
              data-slot="metric-freshness-row"
              data-metric={entry.type}
              data-state={entry.stale ? "stale" : "fresh"}
              className={cn(
                "flex items-center justify-between gap-3 text-xs",
                entry.stale ? "text-warning" : "text-muted-foreground",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {entry.stale ? (
                  <AlertTriangle
                    aria-hidden="true"
                    className="size-3 shrink-0"
                  />
                ) : null}
                <span className="truncate">{label(entry.type)}</span>
              </span>
              <time
                dateTime={entry.lastSeenAt}
                className="shrink-0 tabular-nums"
              >
                {relative(entry.lastSeenAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
