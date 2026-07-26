/**
 * Reading the export, against the file a self-hoster actually attached.
 *
 * The fixture is that export, de-identified as it arrived: 3,395 rows over three
 * and a half years, sixteen medications, two UTC offsets, three statuses, two
 * units, empty cells in four different columns. A hand-built fixture would have
 * had one status and one offset and would have proved nothing about the file that
 * prompted the work.
 *
 * `now` is pinned so the plausibility bound is decided against a fixed clock
 * rather than against the day the suite happens to run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseAutoExportCsv,
  parseAutoExportJson,
  type AutoExportParseOutcome,
} from "../auto-export-parse";

const FIXTURE = readFileSync(
  join(__dirname, "fixtures", "dose-history-export.csv"),
  "utf8",
);

/** After the newest row in the fixture, so nothing is refused as future-dated. */
const NOW = Date.parse("2026-07-01T00:00:00.000Z");

function parseFixture(): AutoExportParseOutcome {
  return parseAutoExportCsv(FIXTURE, { now: NOW });
}

function reasonCounts(outcome: AutoExportParseOutcome) {
  const counts: Record<string, number> = {};
  for (const refusal of outcome.refusals) {
    counts[refusal.reason] = (counts[refusal.reason] ?? 0) + 1;
  }
  return counts;
}

describe("parseAutoExportCsv — the reported export", () => {
  it("reads every row and accounts for each one as a dose or a refusal", () => {
    const outcome = parseFixture();
    expect(outcome.fatal).toBeUndefined();
    expect(outcome.rowsRead).toBe(3395);
    // The property that matters: nothing falls between the two outcomes. A row
    // that is neither a dose nor a named refusal is a silent drop.
    expect(outcome.doses.length + outcome.refusals.length).toBe(
      outcome.rowsRead,
    );
    expect(outcome.doses).toHaveLength(3387);
  });

  it("refuses only the rows whose status records no decision, and names why", () => {
    // The file holds `Taken`, `Skipped` and `Not Interacted`. The first two are
    // decisions the person made; the eight `Not Interacted` rows are the absence
    // of one, and there is no honest dose to write for them.
    expect(reasonCounts(parseFixture())).toEqual({
      status_no_dose_information: 8,
    });
  });

  it("keeps the scheduled slot and the time taken apart", () => {
    const outcome = parseFixture();
    const first = outcome.doses[0];
    // Row 2 of the file: taken 08:38, due 08:00, both at +10:30.
    expect(first.takenAt?.toISOString()).toBe("2023-02-15T22:08:00.000Z");
    expect(first.scheduledFor.toISOString()).toBe("2023-02-15T21:30:00.000Z");
    expect(first.adHoc).toBe(false);
    // 2,799 of the 3,366 taken doses landed after they were due. That is the
    // fact a flattened import destroys: anchoring each dose on its own take time
    // would report every one of them as exactly on time, for ever.
    const late = outcome.doses.filter(
      (dose) =>
        dose.takenAt !== null &&
        dose.takenAt.getTime() > dose.scheduledFor.getTime(),
    );
    expect(late).toHaveLength(2799);
  });

  it("anchors a dose with no scheduled time on itself rather than inventing a slot", () => {
    const outcome = parseFixture();
    const adHoc = outcome.doses.filter((dose) => dose.adHoc);
    expect(adHoc).toHaveLength(2);
    for (const dose of adHoc) {
      expect(dose.scheduledFor.getTime()).toBe(dose.takenAt?.getTime());
    }
  });

  it("records a deliberate skip with no time taken", () => {
    const outcome = parseFixture();
    const skips = outcome.doses.filter((dose) => dose.skipped);
    expect(skips).toHaveLength(21);
    for (const skip of skips) {
      // A skip is a dose that was not taken. The file's `Date` on such a row is
      // when the person pressed skip, and writing that as a take would turn 21
      // refusals into 21 doses.
      expect(skip.takenAt).toBeNull();
      expect(skip.doseTaken).toBeNull();
    }
  });

  it("carries a per-dose amount only where it differs from the scheduled amount", () => {
    const outcome = parseFixture();
    const overridden = outcome.doses.filter((dose) => dose.doseTaken !== null);
    // 25 rows of the file record an actual amount unlike the amount due; the
    // other 3,362 restate the schedule and leave the override absent, which is
    // what `doseTaken` being NULL already means.
    expect(overridden).toHaveLength(25);
    // `1.0 count` renders as `1`: the unit word carries nothing about substance
    // amount, and the trailing zero is the export's spelling, not the dose.
    expect(new Set(overridden.map((dose) => dose.doseTaken))).toEqual(
      new Set(["0.25", "0.5", "1", "1.25", "2"]),
    );
  });

  it("counts the archived rows without letting the flag drop a dose", () => {
    const outcome = parseFixture();
    expect(outcome.fromArchivedMedications).toBe(1462);
    // Nearly half the file. Dropping those rows on the strength of a flag that
    // describes the medication's state today would discard most of the history.
    const archivedDoses = outcome.doses.filter(
      (dose) => dose.fromArchivedMedication,
    );
    expect(archivedDoses.length).toBe(1460);
  });

  it("reads the whole header and finds nothing it has no rule for", () => {
    const outcome = parseFixture();
    expect(outcome.unknownColumns).toEqual([]);
    // Empty on every row of this file. A populated cell would be counted here
    // rather than read, because the CSV documents no encoding for it.
    expect(outcome.csvCodingsIgnored).toBe(0);
  });

  it("keeps both names so either can match a medication on the record", () => {
    const outcome = parseFixture();
    expect(new Set(outcome.doses.map((dose) => dose.medicationName)).size).toBe(
      16,
    );
    // 1,212 of the importable rows leave `Nickname` empty; where it is set it
    // repeats `Medication` verbatim, so in this file it adds nothing — but the
    // format documents it as a name the person chose, and it is the one that
    // might match what the record calls the medication.
    expect(outcome.doses.filter((dose) => dose.nickname === null)).toHaveLength(
      1212,
    );
  });
});

describe("parseAutoExportCsv — refusals", () => {
  const header =
    "Date,Scheduled Date,Medication,Nickname,Dosage,Scheduled Dosage,Unit,Status,Archived,Codings\n";

  function parseRows(...rows: string[]): AutoExportParseOutcome {
    return parseAutoExportCsv(header + rows.join("\n") + "\n", { now: NOW });
  }

  it("refuses a timestamp with no offset rather than reading it in the server's zone", () => {
    const outcome = parseRows(
      "2025-01-01 08:00:00,2025-01-01 08:00:00 +0000,Med,Med,1.0,1.0,count,Taken,No,",
    );
    expect(outcome.doses).toHaveLength(0);
    expect(outcome.refusals).toEqual([
      { line: 2, reason: "missing_timezone_offset" },
    ]);
  });

  it("refuses a future-dated dose", () => {
    const outcome = parseRows(
      "2027-01-01 08:00:00 +0000,,Med,Med,1.0,1.0,count,Taken,No,",
    );
    expect(outcome.refusals).toEqual([
      { line: 2, reason: "implausible_timestamp" },
    ]);
  });

  it("refuses a status the format does not define instead of guessing at it", () => {
    const outcome = parseRows(
      "2025-01-01 08:00:00 +0000,,Med,Med,1.0,1.0,count,Halbwegs,No,",
    );
    expect(outcome.refusals).toEqual([{ line: 2, reason: "status_unknown" }]);
  });

  it("refuses a non-numeric dosage instead of dropping the amount", () => {
    const outcome = parseRows(
      "2025-01-01 08:00:00 +0000,,Med,Med,one,1.0,count,Taken,No,",
    );
    expect(outcome.refusals).toEqual([
      { line: 2, reason: "unreadable_dosage" },
    ]);
  });

  it("refuses a row that lost cells rather than reading the survivors out of position", () => {
    const outcome = parseRows("2025-01-01 08:00:00 +0000,,Med,Med,1.0");
    expect(outcome.refusals).toEqual([{ line: 2, reason: "unreadable_row" }]);
  });

  it("refuses a row naming no medication at all", () => {
    const outcome = parseRows(
      "2025-01-01 08:00:00 +0000,,,,1.0,1.0,count,Taken,No,",
    );
    expect(outcome.refusals).toEqual([
      { line: 2, reason: "missing_medication" },
    ]);
  });

  it("counts a populated Codings cell without reading it", () => {
    const outcome = parseRows(
      "2025-01-01 08:00:00 +0000,,Med,Med,1.0,1.0,count,Taken,No,1191",
    );
    expect(outcome.doses).toHaveLength(1);
    expect(outcome.csvCodingsIgnored).toBe(1);
  });

  it("names a header column it has no rule for", () => {
    const outcome = parseAutoExportCsv(
      "Date,Medication,Status,Mood\n2025-01-01 08:00:00 +0000,Med,Taken,fine\n",
      { now: NOW },
    );
    expect(outcome.unknownColumns).toEqual(["Mood"]);
    expect(outcome.doses).toHaveLength(1);
  });

  it("refuses the whole file when a column it cannot do without is absent", () => {
    const outcome = parseAutoExportCsv("Date,Nickname\n2025-01-01,x\n", {
      now: NOW,
    });
    expect(outcome.fatal).toEqual({
      reason: "missing_required_columns",
      detail: "Medication, Status",
    });
    expect(outcome.doses).toHaveLength(0);
  });

  it("keeps the unit verbatim and drops it for a bare count", () => {
    const outcome = parseRows(
      "2025-01-01 08:00:00 +0000,,Med,Med,0.4,1.0,mL,Taken,No,",
      "2025-01-02 08:00:00 +0000,,Med,Med,0.25,1.0,count,Taken,No,",
    );
    expect(outcome.doses.map((dose) => dose.doseTaken)).toEqual([
      "0.4 mL",
      "0.25",
    ]);
  });
});

describe("parseAutoExportJson", () => {
  it("refuses the JSON shape because it records no time a dose was taken", () => {
    // The documented JSON carries `scheduledDate` and `status` but nothing for
    // the moment of the take. Writing the scheduled time into `takenAt` would
    // manufacture a spotless on-time history the file never claimed.
    const outcome = parseAutoExportJson(
      JSON.stringify([
        {
          displayText: "Aspirin",
          start: "2024-01-01 08:00:00 -0800",
          scheduledDate: "2024-02-06 08:00:00 -0800",
          status: "Taken",
          isArchived: false,
          dosage: 81,
          codings: [
            {
              code: "1191",
              system: "http://www.nlm.nih.gov/research/umls/rxnorm",
            },
          ],
        },
      ]),
    );
    expect(outcome.fatal).toEqual({ reason: "json_carries_no_intake_time" });
    expect(outcome.rowsRead).toBe(1);
    expect(outcome.doses).toHaveLength(0);
  });

  it("tells unreadable text apart from a readable file it will not import", () => {
    expect(parseAutoExportJson("not json").fatal).toEqual({
      reason: "unreadable_json",
    });
    expect(parseAutoExportJson('"a string"').fatal).toEqual({
      reason: "json_not_an_array",
    });
    expect(parseAutoExportJson("[]").fatal).toEqual({ reason: "empty_file" });
  });
});
