"use client";

/**
 * What the intake-import dialog says once an attempt has finished.
 *
 * Split out of the dialog so the outcome can be rendered and asserted on its
 * own — the dialog itself is a sheet with a query client and a file input, and
 * the thing that has to be right is the sentence at the end of the run.
 *
 * The rules are the ones the settings import panel already follows, reused
 * rather than restated: `classifyWrittenOutcome` decides the tone from the
 * counts, so an import that wrote nothing can never carry the success tick,
 * and `WrittenOutcomeLine` owns the tick and the success colour. The skips are
 * grouped by reason with a count, because a file that trips one rule trips it
 * on every row and a per-row list is the same sentence a hundred times.
 *
 * This dialog was not covered when that work landed for the CSV and JSON
 * cards; the medication intake import is the third import surface and it now
 * answers the same way.
 */
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import {
  classifyWrittenOutcome,
  type WrittenOutcome,
} from "@/lib/outcome/written-outcome";
import { useTranslations } from "@/lib/i18n/context";

/** A skip group exactly as the import job reports it. */
export interface IntakeImportSkipGroup {
  reason: string;
  count: number;
}

/**
 * `notice` covers everything that happened before the importer had an opinion —
 * a file was read, the JSON did not parse, the request was refused. `outcome`
 * is the import itself.
 */
export type IntakeImportResultState =
  | { kind: "notice"; tone: "info" | "error"; text: string }
  | {
      kind: "outcome";
      imported: number;
      skipped: number;
      skipReasons: IntakeImportSkipGroup[];
    };

/**
 * Plain language per machine-readable skip reason. Written as literal `t(…)`
 * calls rather than a computed key so the i18n call-site coverage guard sees
 * every one of them.
 */
function useSkipReasonLabel(): (reason: string) => string {
  const { t } = useTranslations();
  const labels: Record<string, string> = {
    duplicate_in_file: t("medications.import.reasonDuplicateInFile"),
    already_recorded: t("medications.import.reasonAlreadyRecorded"),
    medication_not_found: t("medications.import.reasonMedicationNotFound"),
    medication_ambiguous: t("medications.import.reasonMedicationAmbiguous"),
    medication_is_mirrored: t("medications.import.reasonMedicationIsMirrored"),
    status_no_dose_information: t(
      "medications.import.reasonStatusNoDoseInformation",
    ),
    status_reminder_event: t("medications.import.reasonStatusReminderEvent"),
    status_notification_not_sent: t(
      "medications.import.reasonStatusNotificationNotSent",
    ),
    status_unknown: t("medications.import.reasonStatusUnknown"),
    missing_timestamp: t("medications.import.reasonMissingTimestamp"),
    missing_timezone_offset: t("medications.import.reasonMissingOffset"),
    unreadable_timestamp: t("medications.import.reasonUnreadableTimestamp"),
    implausible_timestamp: t("medications.import.reasonImplausibleTimestamp"),
    missing_medication: t("medications.import.reasonMissingMedication"),
    unreadable_dosage: t("medications.import.reasonUnreadableDosage"),
    unreadable_row: t("medications.import.reasonUnreadableRow"),
  };
  const fallback = t("medications.import.reasonUnknown");
  return (reason: string) => labels[reason] ?? fallback;
}

/**
 * The grouped skip lines on their own, without the outcome sentence above them.
 *
 * Split out because a dry-run preview needs exactly these lines and must NOT
 * borrow the outcome sentence: a preview has written nothing, so classifying it
 * by the counts it WOULD produce would put a success tick on a run that never
 * happened. The reason vocabulary is shared; the verdict is not.
 */
export function IntakeImportSkipGroups({
  groups,
  testId = "intake-import-skip-groups",
}: {
  groups: readonly IntakeImportSkipGroup[];
  testId?: string;
}) {
  const { tCount } = useTranslations();
  const labelFor = useSkipReasonLabel();
  if (groups.length === 0) return null;
  return (
    <ul
      data-testid={testId}
      className="text-muted-foreground space-y-0.5 text-xs"
    >
      {groups.map((group) => (
        <li key={group.reason}>
          {tCount("medications.import.skipGroup", group.count, {
            count: group.count,
            reason: labelFor(group.reason),
          })}
        </li>
      ))}
    </ul>
  );
}

export function IntakeImportResultView({
  result,
}: {
  result: IntakeImportResultState;
}) {
  const { t } = useTranslations();

  if (result.kind === "notice") {
    return (
      <p
        data-testid="intake-import-notice"
        data-tone={result.tone}
        className={`text-sm ${result.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
      >
        {result.text}
      </p>
    );
  }

  const outcome: WrittenOutcome = classifyWrittenOutcome({
    written: result.imported,
    skipped: result.skipped,
  });

  const message = (() => {
    if (outcome === "empty") return t("medications.import.resultEmpty");
    if (outcome === "failed") {
      return t("medications.import.resultNothing", { skipped: result.skipped });
    }
    if (outcome === "partial") {
      return t("medications.import.resultPartial", {
        imported: result.imported,
        skipped: result.skipped,
      });
    }
    return t("medications.import.resultSuccess", { imported: result.imported });
  })();

  return (
    <div data-testid="intake-import-result" className="space-y-1.5">
      <WrittenOutcomeLine
        outcome={outcome}
        message={message}
        testId="intake-import-outcome"
      />
      <IntakeImportSkipGroups groups={result.skipReasons} />
    </div>
  );
}
