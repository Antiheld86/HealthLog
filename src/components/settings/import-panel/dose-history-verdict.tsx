"use client";

/**
 * What the importer found in the file, before or alongside what it wrote.
 *
 * Split out of the card so each state can be rendered from a prop and asserted
 * directly — the card itself owns a file input, a query client and a poll loop,
 * and the thing that has to be right is what this block claims.
 *
 * It deliberately does NOT render the outcome sentence. A preview has written
 * nothing, so classifying it by the counts it *would* produce would put a success
 * tick on a run that never ran — the same defect, pointed one step earlier, as
 * the one that made an import of nothing look finished. The reason lines are
 * shared with the real outcome; the verdict is not.
 */
import { IntakeImportSkipGroups } from "@/components/medications/intake-import-result";
import { useTranslations } from "@/lib/i18n/context";

/** The file-level verdict, exactly as the route returns it. */
export interface DoseHistoryFileVerdict {
  rowsRead: number;
  queued: number;
  refused: number;
  refusedByReason: Array<{ reason: string; count: number }>;
  unmatchedMedications: string[];
  ambiguousMedications: string[];
  mirroredMedications: string[];
  unknownColumns: string[];
  codingsNotRead: number;
  fromArchivedMedications: number;
}

export function DoseHistoryVerdictView({
  verdict,
  previewOnly,
}: {
  verdict: DoseHistoryFileVerdict;
  previewOnly: boolean;
}) {
  const { t } = useTranslations();
  return (
    <div
      data-testid="dose-history-verdict"
      className="space-y-1 text-xs"
      data-preview={previewOnly ? "true" : "false"}
    >
      <p className="text-foreground">
        {previewOnly
          ? t("settings.sections.export.import.doseHistory.previewLine", {
              rows: verdict.rowsRead,
              queued: verdict.queued,
              refused: verdict.refused,
            })
          : t("settings.sections.export.import.doseHistory.submittedLine", {
              rows: verdict.rowsRead,
              queued: verdict.queued,
            })}
      </p>
      <IntakeImportSkipGroups
        groups={verdict.refusedByReason}
        testId="dose-history-refusal-groups"
      />
      {verdict.unmatchedMedications.length > 0 && (
        <p
          className="text-muted-foreground"
          data-testid="dose-history-unmatched"
        >
          {t("settings.sections.export.import.doseHistory.unmatched", {
            names: verdict.unmatchedMedications.join(", "),
          })}
        </p>
      )}
      {verdict.ambiguousMedications.length > 0 && (
        <p className="text-muted-foreground">
          {t("settings.sections.export.import.doseHistory.ambiguous", {
            names: verdict.ambiguousMedications.join(", "),
          })}
        </p>
      )}
      {verdict.mirroredMedications.length > 0 && (
        <p className="text-muted-foreground">
          {t("settings.sections.export.import.doseHistory.mirrored", {
            names: verdict.mirroredMedications.join(", "),
          })}
        </p>
      )}
      {verdict.unknownColumns.length > 0 && (
        <p className="text-muted-foreground">
          {t("settings.sections.export.import.doseHistory.unknownColumns", {
            names: verdict.unknownColumns.join(", "),
          })}
        </p>
      )}
      {verdict.codingsNotRead > 0 && (
        <p className="text-muted-foreground">
          {t("settings.sections.export.import.doseHistory.codingsNotRead", {
            count: verdict.codingsNotRead,
          })}
        </p>
      )}
      {verdict.fromArchivedMedications > 0 && (
        <p
          className="text-muted-foreground"
          data-testid="dose-history-archived"
        >
          {t("settings.sections.export.import.doseHistory.archivedRows", {
            count: verdict.fromArchivedMedications,
          })}
        </p>
      )}
    </div>
  );
}
