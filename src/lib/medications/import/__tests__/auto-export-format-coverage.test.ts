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
  AUTO_EXPORT_ACTIONABLE_STATUSES,
} from "../auto-export-format";
import { AUTO_EXPORT_REFUSAL_REASONS } from "../auto-export-parse";

describe("export column rulings", () => {
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
  it("treats only a recorded decision as actionable", () => {
    for (const status of AUTO_EXPORT_ACTIONABLE_STATUSES) {
      expect(AUTO_EXPORT_STATUSES).toContain(status);
    }
    // The other five documented values name the absence of a decision. Widening
    // this set means deciding what row to write for "nobody acted", which is a
    // compliance judgement the export never made.
    expect(AUTO_EXPORT_ACTIONABLE_STATUSES).toEqual(["Taken", "Skipped"]);
  });
});

describe("refusal vocabulary", () => {
  it("spells every parse-time refusal the same as a job skip reason", () => {
    for (const reason of AUTO_EXPORT_REFUSAL_REASONS) {
      expect(MEDICATION_IMPORT_SKIP_REASONS, reason).toContain(reason);
    }
  });
});
