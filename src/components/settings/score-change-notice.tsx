"use client";

/**
 * The Health Score's "something about this number changed" note, rendered
 * for the first time.
 *
 * The machinery behind it shipped a while ago and has been raising,
 * persisting and evicting a notice that nothing ever drew: the report has
 * carried `algorithmNotice` for its whole life and no surface read it.
 * This is that renderer. It sits on the settings page rather than on the
 * hero because the note's whole subject is what counts toward the score,
 * and the person reading it is one tap from acting on it.
 *
 * Two notes ride one key, told apart by the account's own recipe version.
 *
 *   - **Version 0** — nobody has chosen yet. The note explains what the
 *     upgrade did: what counts used to follow the module switches, it now
 *     follows this page, and the number itself did not move. It is the
 *     one-time note for accounts that existed before the choice did, and
 *     it is written to be true for a fresh account as well, because the
 *     stored recipe cannot tell the two apart and inventing a distinction
 *     from the account's age would be guessing.
 *   - **Version 1 and up** — the person changed what counts, on a date
 *     the recipe records. The note says what that does to the history.
 *
 * Dismissal is per key, so a dismissal of one version never silences the
 * next, and it survives a reload because the server holds it.
 */

import { Info, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

export interface ScoreChangeNoticeProps {
  /** The account's own recipe version. 0 while nobody has chosen. */
  configVersion: number;
  /** When the recipe last changed, ISO 8601, or null while it never has. */
  changedAt: string | null;
  /** Fired when the person acknowledges the note. */
  onDismiss: () => void;
  dismissing?: boolean;
}

export function ScoreChangeNotice({
  configVersion,
  changedAt,
  onDismiss,
  dismissing = false,
}: ScoreChangeNoticeProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const kind = configVersion >= 1 ? "changed" : "upgrade";
  const parsed = changedAt ? new Date(changedAt) : null;
  const dateLabel =
    parsed && !Number.isNaN(parsed.getTime()) ? fmt.date(parsed) : null;

  // Written out rather than assembled from the discriminator so the i18n
  // call-site guard can see every key this component can reach.
  const title =
    kind === "changed"
      ? t("settings.sections.score.notice.changed.title")
      : t("settings.sections.score.notice.upgrade.title");
  const body =
    kind !== "changed"
      ? t("settings.sections.score.notice.upgrade.body")
      : dateLabel
        ? t("settings.sections.score.notice.changed.body", { date: dateLabel })
        : t("settings.sections.score.notice.changed.bodyUndated");

  return (
    <SettingsCard
      as="section"
      data-slot="score-change-notice"
      data-kind={kind}
      aria-labelledby="score-change-notice-title"
    >
      <SettingsCardHeader
        icon={Info}
        titleId="score-change-notice-title"
        title={title}
      />
      <p data-slot="score-change-notice-body" className="text-sm">
        {body}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onDismiss}
        disabled={dismissing}
        data-slot="score-change-notice-dismiss"
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
