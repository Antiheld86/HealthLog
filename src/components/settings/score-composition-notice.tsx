"use client";

/**
 * "A pillar stopped counting" — the settings half of the composition note.
 *
 * It sits beside `<ScoreChangeNotice>` rather than inside it because the two
 * answer different questions with different remedies. That one says the
 * rules or the recipe moved and the person is one tap from the rows that
 * decide the recipe. This one says the DATA moved: nobody changed anything,
 * a window rolled past its floor or a source went quiet, and the row for
 * that pillar on this page already shows what it is waiting for.
 *
 * Reasons are deliberately not repeated here. The insights panel states
 * them beside the number they explain, and the pillar rows below this card
 * carry the server's own verdict per pillar; a third copy on this surface
 * would be a third place to drift.
 *
 * Dismissal is per key and the key is the resulting SET, so acknowledging
 * this note holds until the set moves again — not until tomorrow.
 */

import { Info, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { SCORE_PILLAR_LABEL_KEYS } from "@/lib/score-config/labels";
import type { ScorePillarId } from "@/lib/analytics/score/types";

export interface ScoreCompositionNoticeProps {
  /** Pillars that counted on the last stored day and do not count now. */
  left: ScorePillarId[];
  /** Pillars that count now and did not on the last stored day. */
  joined: ScorePillarId[];
  onDismiss: () => void;
  dismissing?: boolean;
}

export function ScoreCompositionNotice({
  left,
  joined,
  onDismiss,
  dismissing = false,
}: ScoreCompositionNoticeProps) {
  const { t } = useTranslations();

  function names(ids: ScorePillarId[]): string {
    return ids.map((id) => t(SCORE_PILLAR_LABEL_KEYS[id])).join(", ");
  }

  // Written out rather than assembled from a discriminator so the i18n
  // call-site guard can see every key this component can reach.
  const leftLine =
    left.length > 0
      ? t("settings.sections.score.notice.composition.left", {
          pillars: names(left),
        })
      : null;
  const joinedLine =
    joined.length > 0
      ? t("settings.sections.score.notice.composition.joined", {
          pillars: names(joined),
        })
      : null;

  return (
    <SettingsCard
      as="section"
      data-slot="score-composition-notice"
      aria-labelledby="score-composition-notice-title"
    >
      <SettingsCardHeader
        icon={Info}
        titleId="score-composition-notice-title"
        title={t("settings.sections.score.notice.composition.title")}
      />
      <p data-slot="score-composition-notice-body" className="text-sm">
        {[leftLine, joinedLine].filter(Boolean).join(" ")}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onDismiss}
        disabled={dismissing}
        data-slot="score-composition-notice-dismiss"
        className="min-h-11 sm:min-h-9"
      >
        {dismissing ? (
          <Loader2
            aria-hidden="true"
            className="size-3.5 animate-spin motion-reduce:animate-none"
          />
        ) : null}
        {t("settings.sections.score.notice.dismiss")}
      </Button>
    </SettingsCard>
  );
}
