"use client";

/**
 * One pillar on the "what counts toward your Health Score" surface.
 *
 * The row carries the pillar's name, one line about where it currently
 * stands with the server, and the switch that decides whether it counts.
 * Nothing else: recording and showing are the modules screen's business,
 * and repeating them on every row was noise on a page about a third
 * question.
 *
 * Presentation only. The parent owns the draft, the mutation and the
 * cache, so this stays a leaf a test can drive directly.
 */

import { Loader2 } from "lucide-react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";
import { SCORE_PILLAR_LABEL_KEYS } from "@/lib/score-config/labels";
import {
  showsWaitingForData,
  type ScoreConfigRow,
} from "@/lib/score-config/rows";

/** The eligibility values that earn a line of their own, and their copy. */
const ELIGIBILITY_LINE_KEYS: Partial<
  Record<ScoreConfigRow["eligibility"], string>
> = {
  counting: "settings.sections.score.state.counting",
  crisis: "settings.sections.score.state.crisis",
  read_failed: "settings.sections.score.state.readFailed",
};

export interface ScorePillarRowProps {
  row: ScoreConfigRow;
  /** Disables the switch while a save is in flight. */
  pending?: boolean;
  onToggle: (next: boolean) => void;
}

export function ScorePillarRow({
  row,
  pending = false,
  onToggle,
}: ScorePillarRowProps) {
  const { t } = useTranslations();
  const inputId = `score-pillar-${row.id}`;
  // "Selected, waiting for data" is checked first because it is the one
  // line that depends on the draft as well as on the server's verdict.
  const stateKey = showsWaitingForData(row)
    ? "settings.sections.score.state.waiting"
    : ELIGIBILITY_LINE_KEYS[row.eligibility];

  return (
    <div
      data-slot="score-pillar-row"
      data-pillar={row.id}
      data-domain={row.domain}
      data-counts={row.counts ? "true" : "false"}
      data-eligibility={row.eligibility}
      className="flex min-h-11 items-center justify-between gap-4 py-3"
    >
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={inputId} className="text-sm font-medium">
          {t(SCORE_PILLAR_LABEL_KEYS[row.id])}
        </Label>
        {stateKey ? (
          <p
            data-slot="score-pillar-state"
            data-state={showsWaitingForData(row) ? "waiting" : row.eligibility}
            className="text-muted-foreground text-xs"
          >
            {t(stateKey)}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {pending ? (
          <Loader2
            aria-hidden="true"
            className="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none"
          />
        ) : null}
        <Switch
          id={inputId}
          data-slot="score-pillar-switch"
          checked={row.counts}
          disabled={pending}
          onCheckedChange={(next) => onToggle(next)}
          aria-label={t("settings.sections.score.axis.countsFor", {
            pillar: t(SCORE_PILLAR_LABEL_KEYS[row.id]),
          })}
        />
      </div>
    </div>
  );
}
