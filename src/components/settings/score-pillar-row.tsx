"use client";

/**
 * One pillar on the "what counts toward your Health Score" surface.
 *
 * The row's job is to make three things legible that nowhere else in the
 * app shows together: whether the pillar is being recorded, whether it is
 * shown, and whether it counts toward the score. Only the last is
 * writable here, and the card above the rows says so in words.
 *
 * The first two are not switches on this surface and are not dressed to
 * look like ones. They are read-outs, because the page that owns them is
 * the modules screen and a second switch for the same fact is how two
 * places end up disagreeing about one thing.
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
  unavailable: "settings.sections.score.state.unavailableDetail",
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
      data-selectable={row.selectable ? "true" : "false"}
      className="flex items-start justify-between gap-4 py-3"
    >
      <div className="min-w-0 space-y-1">
        <Label htmlFor={inputId} className="text-sm font-medium">
          {t(SCORE_PILLAR_LABEL_KEYS[row.id])}
        </Label>
        {/* The three axes, side by side. Recording and showing read as
            settled facts; the third is the switch to the right. */}
        <p
          data-slot="score-pillar-axes"
          className="text-muted-foreground text-xs"
        >
          <span data-slot="score-pillar-axis-recorded">
            {t("settings.sections.score.axis.recorded")}
          </span>
          {" · "}
          <span data-slot="score-pillar-axis-shown">
            {t("settings.sections.score.axis.shown")}
          </span>
        </p>
        {stateKey ? (
          <p
            data-slot="score-pillar-state"
            data-state={showsWaitingForData(row) ? "waiting" : row.eligibility}
            className="text-foreground text-xs"
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
        {row.selectable ? (
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
        ) : (
          // Not a disabled switch pretending to be a choice: a pillar this
          // build can never score has no state to show, so it says so.
          // `aria-disabled` + the opacity container is the standard
          // disabled look (UI-STANDARDS §3).
          <span
            data-slot="score-pillar-unavailable"
            aria-disabled="true"
            className="text-muted-foreground text-xs opacity-50"
          >
            {t("settings.sections.score.state.unavailable")}
          </span>
        )}
      </div>
    </div>
  );
}
