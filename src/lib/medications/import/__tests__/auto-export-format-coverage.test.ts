/**
 * Structural: no field of the export can exist without a verdict.
 *
 * "Every column gets an explicit verdict" is only true while it stays true. A
 * column added to the parser and not to the ruling table would be read, or not
 * read, without anyone being told either way — which is the exact defect this
 * import path was built to remove, and the kind that survives a review because
 * every other check passes.
 *
 * Also pins that a parse-time refusal is spelled the same as a job skip reason.
 * The two vocabularies feed one label set in the UI, so a reason that exists in
 * only one of them renders as "reason not recorded" — a refusal the person cannot
 * act on.
 */
import { describe, expect, it } from "vitest";

import { MEDICATION_IMPORT_SKIP_REASONS } from "@/lib/jobs/medication-intake-import";

import {
  AUTO_EXPORT_COLUMN_RULINGS,
  AUTO_EXPORT_CSV_COLUMNS,
  AUTO_EXPORT_JSON_FIELDS,
  AUTO_EXPORT_STATUSES,
  AUTO_EXPORT_STATUS_DISPOSITIONS,
} from "../auto-export-format";
import {
  AUTO_EXPORT_REFUSAL_REASONS,
  parseAutoExportCsv,
} from "../auto-export-parse";

describe("export column rulings", () => {
  /**
   * The verdicts, spelled out.
   *
   * Every other assertion here reads the verdict off the same table it is
   * checking, so a column flipped from `honoured` to `ignored` would move both
   * sides of the comparison and pass — the importer would quietly stop using a
   * column and the card would quietly say so, with nothing failing in between.
   * Restating them as literals is what makes such a flip a decision somebody has
   * to write down twice.
   */
  const EXPECTED_VERDICTS: Record<string, string> = {
    Date: "honoured",
    "Scheduled Date": "honoured",
    Medication: "honoured",
    Nickname: "honoured",
    Dosage: "honoured",
    "Scheduled Dosage": "honoured",
    Unit: "honoured",
    Status: "honoured",
    Archived: "reported",
    Codings: "ignored",
    form: "ignored",
    start: "ignored",
    end: "ignored",
  };

  it("holds the verdict each column was decided to have", () => {
    expect(
      Object.fromEntries(
        AUTO_EXPORT_COLUMN_RULINGS.map((ruling) => [
          ruling.column,
          ruling.verdict,
        ]),
      ),
    ).toEqual(EXPECTED_VERDICTS);
  });

  it("rules on every CSV column exactly once", () => {
    const ruled = AUTO_EXPORT_COLUMN_RULINGS.filter(
      (ruling) => !ruling.jsonOnly,
    ).map((ruling) => ruling.column);
    expect(ruled).toEqual([...AUTO_EXPORT_CSV_COLUMNS]);
  });

  it("rules on every documented JSON field, under its CSV name where it shares one", () => {
    const ruled = new Set(
      AUTO_EXPORT_COLUMN_RULINGS.map((ruling) => ruling.column.toLowerCase()),
    );
    // The JSON spellings that differ from the CSV column they are the same fact
    // as. Anything not on this map has to appear in the rulings by its own name.
    const aliases: Record<string, string> = {
      displaytext: "medication",
      isarchived: "archived",
      scheduleddate: "scheduled date",
    };
    for (const field of AUTO_EXPORT_JSON_FIELDS) {
      const key = aliases[field.toLowerCase()] ?? field.toLowerCase();
      expect(ruled, `no ruling for JSON field ${field}`).toContain(key);
    }
  });

  it("carries no ruling for a field neither shape has", () => {
    const known = new Set<string>([
      ...AUTO_EXPORT_CSV_COLUMNS.map((column) => column.toLowerCase()),
      ...AUTO_EXPORT_JSON_FIELDS.map((field) => field.toLowerCase()),
    ]);
    for (const ruling of AUTO_EXPORT_COLUMN_RULINGS) {
      expect(known, `ruling for unknown field ${ruling.column}`).toContain(
        ruling.column.toLowerCase(),
      );
    }
  });

  it("gives every ruling a distinct note key, so no two share a sentence", () => {
    const keys = AUTO_EXPORT_COLUMN_RULINGS.map((ruling) => ruling.noteKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("status vocabulary", () => {
  /**
   * The ruling per documented status, written out.
   *
   * The file that prompted this work contains three of the seven, so the other
   * four are documented-but-unobserved — and an unobserved status is exactly the
   * one a later edit can quietly promote into a dose, because no fixture would
   * notice. Restating all seven means promoting any of them has to be typed
   * twice.
   */
  const EXPECTED: Record<string, string> = {
    Taken: "dose_taken",
    Skipped: "dose_skipped",
    "Not Interacted": "no_dose_information",
    "Not Logged": "no_dose_information",
    Unspecified: "no_dose_information",
    Snoozed: "reminder_event",
    "Notification Not Sent": "app_event",
  };

  it("holds the ruling each documented status was decided to have", () => {
    expect({ ...AUTO_EXPORT_STATUS_DISPOSITIONS }).toEqual(EXPECTED);
  });

  it("rules on every documented status, and on nothing else", () => {
    expect(Object.keys(AUTO_EXPORT_STATUS_DISPOSITIONS).sort()).toEqual(
      [...AUTO_EXPORT_STATUSES].sort(),
    );
  });

  it("writes a row for exactly the two statuses that state a decision", () => {
    const header =
      "Date,Scheduled Date,Medication,Nickname,Dosage,Scheduled Dosage,Unit,Status,Archived,Codings\n";
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    // One row per documented status, so every status is exercised — including
    // the four the reported file never contained.
    for (const status of AUTO_EXPORT_STATUSES) {
      const outcome = parseAutoExportCsv(
        `${header}2025-01-01 08:00:00 +1030,2025-01-01 08:00:00 +1030,Med,Med,1.0,1.0,count,${status},No,\n`,
        { now },
      );
      const expectsDose =
        EXPECTED[status] === "dose_taken" ||
        EXPECTED[status] === "dose_skipped";
      expect(outcome.doses.length, `${status} → dose`).toBe(
        expectsDose ? 1 : 0,
      );
      if (expectsDose) {
        // A skip is a dose not taken; only `Taken` carries a take time. Neither
        // is inferred from the other.
        expect(outcome.doses[0].takenAt === null).toBe(
          EXPECTED[status] === "dose_skipped",
        );
      } else {
        // Refused, and under a reason of its own rather than a shared total.
        expect(outcome.refusals, `${status} → refusal`).toHaveLength(1);
        expect(outcome.refusals[0].reason).toBe(
          {
            no_dose_information: "status_no_dose_information",
            reminder_event: "status_reminder_event",
            app_event: "status_notification_not_sent",
          }[EXPECTED[status]],
        );
      }
    }
  });
});

describe("refusal vocabulary", () => {
  it("spells every parse-time refusal the same as a job skip reason", () => {
    for (const reason of AUTO_EXPORT_REFUSAL_REASONS) {
      expect(MEDICATION_IMPORT_SKIP_REASONS, reason).toContain(reason);
    }
  });
});
