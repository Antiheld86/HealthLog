/**
 * Matching a file's medications to the record, and what is refused.
 *
 * The whole-file numbers are asserted against the reported export because the
 * arithmetic that matters is `imported + refused = rows read`. A count that does
 * not add up is how a run that lost rows reads as a run that finished.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { totalMedicationImportSkips } from "@/lib/jobs/medication-intake-import";

import { parseAutoExportCsv } from "../auto-export-parse";
import {
  planAutoExportImport,
  type MedicationMatchCandidate,
} from "../auto-export-plan";

const FIXTURE = readFileSync(
  join(__dirname, "fixtures", "dose-history-export.csv"),
  "utf8",
);
const NOW = Date.parse("2026-07-01T00:00:00.000Z");

const FIXTURE_MEDICATION_NAMES = Array.from(
  { length: 16 },
  (_, index) => `Med_${index + 1}`,
);

function medication(
  name: string,
  overrides: Partial<MedicationMatchCandidate> = {},
): MedicationMatchCandidate {
  return {
    id: `id-${name}`,
    name,
    externalSource: null,
    ...overrides,
  };
}

function planFixture(medications: readonly MedicationMatchCandidate[]) {
  return planAutoExportImport(
    parseAutoExportCsv(FIXTURE, { now: NOW }),
    medications,
  );
}

const header =
  "Date,Scheduled Date,Medication,Nickname,Dosage,Scheduled Dosage,Unit,Status,Archived,Codings\n";

function planRows(
  rows: readonly string[],
  medications: readonly MedicationMatchCandidate[],
) {
  return planAutoExportImport(
    parseAutoExportCsv(header + rows.join("\n") + "\n", { now: NOW }),
    medications,
  );
}

describe("planAutoExportImport — the reported export", () => {
  it("queues every importable row when the record holds all sixteen medications", () => {
    const plan = planFixture(
      FIXTURE_MEDICATION_NAMES.map((n) => medication(n)),
    );
    expect(plan.entries).toHaveLength(3387);
    expect(plan.unmatchedMedications).toEqual([]);
    // The arithmetic the person reads at the end of the run.
    expect(
      plan.entries.length + totalMedicationImportSkips(plan.skippedByReason),
    ).toBe(plan.rowsRead);
    expect(plan.skippedByReason).toEqual({ status_no_dose_information: 8 });
  });

  it("names the medications it could not match instead of reporting a number", () => {
    const plan = planFixture([medication("Med_13"), medication("Med_9")]);
    // Two medications on the record, so only their rows land. The rest are
    // refused under a reason, and the names come back so they can be added.
    expect(plan.entries.length).toBeGreaterThan(0);
    expect(plan.skippedByReason.medication_not_found).toBe(
      3387 - plan.entries.length,
    );
    expect(plan.unmatchedMedications).toHaveLength(14);
    expect(plan.unmatchedMedications).not.toContain("Med_13");
    expect(
      plan.entries.length + totalMedicationImportSkips(plan.skippedByReason),
    ).toBe(plan.rowsRead);
  });

  it("never creates a medication from the file", () => {
    // With nothing on the record, an importer that invented medications would
    // land 3,387 rows. Every one is refused instead, by name.
    const plan = planFixture([]);
    expect(plan.entries).toEqual([]);
    expect(plan.skippedByReason.medication_not_found).toBe(3387);
    expect(plan.unmatchedMedications).toHaveLength(16);
  });

  it("identifies a dose by its medication and its slot, so a re-run replays", () => {
    const plan = planFixture(
      FIXTURE_MEDICATION_NAMES.map((n) => medication(n)),
    );
    const keys = new Set(plan.entries.map((entry) => entry.idempotencyKey));
    // One key per dose. The key used to come from an optional counter field,
    // which is how 28 distinct instants collapsed onto one.
    expect(keys.size).toBe(plan.entries.length);
    const again = planFixture(
      FIXTURE_MEDICATION_NAMES.map((n) => medication(n)),
    );
    expect(again.entries.map((entry) => entry.idempotencyKey)).toEqual(
      plan.entries.map((entry) => entry.idempotencyKey),
    );
  });

  it("carries the scheduled slot, the take and the medication onto every entry", () => {
    const plan = planFixture(
      FIXTURE_MEDICATION_NAMES.map((n) => medication(n)),
    );
    expect(plan.entries[0]).toEqual({
      medicationId: "id-Med_13",
      scheduledFor: "2023-02-15T21:30:00.000Z",
      takenAt: "2023-02-15T22:08:00.000Z",
      idempotencyKey: `import-id-Med_13-${Date.parse("2023-02-15T21:30:00.000Z")}`,
      sourceLine: 2,
    });
  });
});

describe("planAutoExportImport — matching", () => {
  it("matches a name case- and whitespace-blind", () => {
    const plan = planRows(
      ["2025-01-01 08:00:00 +0000,,  ramipril  ,,1.0,1.0,count,Taken,No,"],
      [medication("Ramipril")],
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].medicationId).toBe("id-Ramipril");
  });

  it("falls back to the nickname when the display name matches nothing", () => {
    const plan = planRows(
      [
        "2025-01-01 08:00:00 +0000,,Long brand name,Evening pill,1.0,1.0,count,Taken,No,",
      ],
      [medication("Evening pill")],
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].medicationId).toBe("id-Evening pill");
  });

  it("refuses an ambiguous name rather than picking one of the two", () => {
    const plan = planRows(
      ["2025-01-01 08:00:00 +0000,,Ramipril,,1.0,1.0,count,Taken,No,"],
      [
        { id: "a", name: "Ramipril", externalSource: null },
        { id: "b", name: "ramipril", externalSource: null },
      ],
    );
    expect(plan.entries).toEqual([]);
    expect(plan.skippedByReason).toEqual({ medication_ambiguous: 1 });
    expect(plan.ambiguousMedications).toEqual(["Ramipril"]);
  });

  it("refuses a medication mirrored from another app", () => {
    // A mirrored row is a read-only copy and only that source's dose events
    // attach to it. An imported dose inside the mirror would be a row the mirror
    // never asserted.
    const plan = planRows(
      ["2025-01-01 08:00:00 +0000,,Ramipril,,1.0,1.0,count,Taken,No,"],
      [medication("Ramipril", { externalSource: "APPLE_HEALTH" })],
    );
    expect(plan.entries).toEqual([]);
    expect(plan.skippedByReason).toEqual({ medication_is_mirrored: 1 });
    expect(plan.mirroredMedications).toEqual(["Ramipril"]);
  });

  it("counts two rows of one file landing on the same slot apart from a replay", () => {
    const plan = planRows(
      [
        "2025-01-01 08:05:00 +0000,2025-01-01 08:00:00 +0000,Ramipril,,1.0,1.0,count,Taken,No,",
        "2025-01-01 08:40:00 +0000,2025-01-01 08:00:00 +0000,Ramipril,,1.0,1.0,count,Taken,No,",
      ],
      [medication("Ramipril")],
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.skippedByReason).toEqual({ duplicate_in_file: 1 });
  });

  it("keeps two medications sharing one slot apart", () => {
    const plan = planRows(
      [
        "2025-01-01 08:00:00 +0000,2025-01-01 08:00:00 +0000,Ramipril,,1.0,1.0,count,Taken,No,",
        "2025-01-01 08:00:00 +0000,2025-01-01 08:00:00 +0000,Metformin,,1.0,1.0,count,Taken,No,",
      ],
      [medication("Ramipril"), medication("Metformin")],
    );
    expect(plan.entries).toHaveLength(2);
    expect(plan.skippedByReason).toEqual({});
  });

  it("hands a deliberate skip through with no take time", () => {
    const plan = planRows(
      [
        "2025-01-01 09:00:00 +0000,2025-01-01 08:00:00 +0000,Ramipril,,1.0,1.0,count,Skipped,No,",
      ],
      [medication("Ramipril")],
    );
    expect(plan.entries).toEqual([
      {
        medicationId: "id-Ramipril",
        scheduledFor: "2025-01-01T08:00:00.000Z",
        takenAt: null,
        idempotencyKey: `import-id-Ramipril-${Date.parse("2025-01-01T08:00:00.000Z")}`,
        sourceLine: 2,
      },
    ]);
  });

  it("keeps only safe line-and-reason detail for every refusal", () => {
    const plan = planRows(
      [
        "2025-01-01 08:00:00 +0000,2025-01-01 08:00:00 +0000,Ramipril,,1.0,1.0,count,Taken,No,",
        "2025-01-01 08:30:00 +0000,2025-01-01 08:00:00 +0000,Ramipril,,1.0,1.0,count,Taken,No,",
        "2025-01-02 08:00:00 +0000,,Unknown medicine,,1.0,1.0,count,Taken,No,",
      ],
      [medication("Ramipril")],
    );

    expect(plan.skipDetails).toEqual([
      { line: 3, reason: "duplicate_in_file" },
      { line: 4, reason: "medication_not_found" },
    ]);
    expect(plan.skippedDetailsOmitted).toBe(0);
    expect(JSON.stringify(plan.skipDetails)).not.toContain("Ramipril");
    expect(JSON.stringify(plan.skipDetails)).not.toContain("2025-01");
  });
});
