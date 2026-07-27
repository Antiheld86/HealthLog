"use client";

import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { useTranslations } from "@/lib/i18n/context";
import {
  classifyWrittenOutcome,
  groupSkipReasons,
  type WrittenRowResult,
} from "@/lib/outcome/written-outcome";

export interface CsvImportResult {
  inserted: number;
  updated: number;
  skipped: number;
  total: number;
  dryRun: boolean;
  rows: WrittenRowResult[];
}

/**
 * Plain-language label per machine-readable skip reason.
 *
 * Written as literal `t(...)` calls rather than a key lookup so the i18n
 * call-site coverage guard sees every one of them.
 */
function useSkipReasonLabel(): (reason: string) => string {
  const { t } = useTranslations();
  const labels: Record<string, string> = {
    unknown_type: t("settings.sections.export.import.csv.reasonUnknownType"),
    invalid_value: t("settings.sections.export.import.csv.reasonInvalidValue"),
    value_out_of_range: t(
      "settings.sections.export.import.csv.reasonValueOutOfRange",
    ),
    unknown_unit: t("settings.sections.export.import.csv.reasonUnknownUnit"),
    missing_timezone_offset: t(
      "settings.sections.export.import.csv.reasonMissingTimezoneOffset",
    ),
    invalid_timestamp: t(
      "settings.sections.export.import.csv.reasonInvalidTimestamp",
    ),
    implausible_timestamp: t(
      "settings.sections.export.import.csv.reasonImplausibleTimestamp",
    ),
    unexpected_glucose_context: t(
      "settings.sections.export.import.csv.reasonUnexpectedGlucoseContext",
    ),
    invalid_glucose_context: t(
      "settings.sections.export.import.csv.reasonInvalidGlucoseContext",
    ),
    notes_too_long: t("settings.sections.export.import.csv.reasonNotesTooLong"),
    external_id_too_long: t(
      "settings.sections.export.import.csv.reasonExternalIdTooLong",
    ),
    unstable_external_id: t(
      "settings.sections.export.import.csv.reasonUnstableExternalId",
    ),
    duplicate: t("settings.sections.export.import.csv.reasonDuplicate"),
  };
  const fallback = t("settings.sections.export.import.csv.reasonUnknown");
  return (reason: string) => labels[reason] ?? fallback;
}

/**
 * The CSV import result: an honest headline, then the skipped rows grouped by
 * reason with a count, with the per-line detail kept one disclosure away.
 */
export function CsvImportResultView({ result }: { result: CsvImportResult }) {
  const { t, tCount } = useTranslations();
  const labelFor = useSkipReasonLabel();

  const written = result.inserted + result.updated;
  const outcome = classifyWrittenOutcome({ written, skipped: result.skipped });
  const groups = groupSkipReasons(result.rows);
  const skippedRows = result.rows.filter((row) => row.status === "skipped");

  const message = (() => {
    if (outcome === "empty") {
      return t("settings.sections.export.import.csv.resultEmpty");
    }
    if (result.dryRun) {
      if (outcome === "failed") {
        return t("settings.sections.export.import.csv.previewNothing", {
          skipped: result.skipped,
        });
      }
      if (outcome === "partial") {
        return t("settings.sections.export.import.csv.previewSummary", {
          inserted: result.inserted,
          skipped: result.skipped,
        });
      }
      return t("settings.sections.export.import.csv.previewSuccess", {
        inserted: result.inserted,
      });
    }
    if (outcome === "failed") {
      return t("settings.sections.export.import.csv.resultNothing", {
        skipped: result.skipped,
      });
    }
    if (outcome === "partial") {
      return t("settings.sections.export.import.csv.resultSummary", {
        inserted: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
      });
    }
    return t("settings.sections.export.import.csv.resultSuccess", {
      inserted: result.inserted,
      updated: result.updated,
    });
  })();

  return (
    <div data-testid="import-csv-result" className="space-y-1.5">
      <WrittenOutcomeLine
        outcome={outcome}
        message={message}
        testId="import-csv-outcome"
      />
      {groups.length > 0 && (
        <ul
          data-testid="import-csv-skip-groups"
          className="text-muted-foreground space-y-0.5 text-xs"
        >
          {groups.map((group) => (
            <li key={group.reason}>
              {tCount(
                "settings.sections.export.import.csv.skipGroup",
                group.count,
                { count: group.count, reason: labelFor(group.reason) },
              )}
            </li>
          ))}
        </ul>
      )}
      {skippedRows.length > 0 && (
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer">
            {t("settings.sections.export.import.csv.skipDetails")}
          </summary>
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-auto">
            {skippedRows.map((row) => (
              <li key={row.line}>
                {t("settings.sections.export.import.csv.rowError", {
                  line: row.line,
                  reason: labelFor(row.reason ?? "unknown"),
                })}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
