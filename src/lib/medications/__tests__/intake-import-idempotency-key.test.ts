/**
 * Both intake-import surfaces must derive the same replay key.
 *
 * The key is what makes a re-run cost nothing: it matches the live-row unique
 * on `(user_id, medication_id, scheduled_for, source)`, so a second submission
 * of the same dose collides instead of writing a second ledger row. The two
 * surfaces — the hand-listed per-medication body and the export reader — used
 * to build the string separately, which meant a change to one silently stopped
 * the other from deduplicating its replays. They now share one function; this
 * pins that they agree for the same medication and instant, so a future split
 * fails here rather than in a user's ledger.
 */
import { describe, expect, it } from "vitest";

import { planAutoExportImport } from "../import/auto-export-plan";
import { parseAutoExportCsv } from "../import/auto-export-parse";
import {
  buildMedicationImportEntries,
  medicationImportIdempotencyKey,
} from "../intake-import-payload";

const MEDICATION_ID = "med_shared";
/** The instant both surfaces are asked about, expressed each one's own way. */
const LOCAL_DATE = "2025-03-09";
const LOCAL_TIME = "07:30";
const INSTANT = new Date(`${LOCAL_DATE}T${LOCAL_TIME}`);

const CSV_HEADER =
  "Date,Scheduled Date,Medication,Nickname,Dose Taken,Dose,Unit,Status,Skipped,Notes";

function offsetSuffix(at: Date): string {
  const minutes = -at.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

describe("intake-import replay keys", () => {
  it("derives the key from the medication and the slot instant only", () => {
    expect(medicationImportIdempotencyKey(MEDICATION_ID, INSTANT)).toBe(
      `import-${MEDICATION_ID}-${INSTANT.getTime()}`,
    );
  });

  it("gives the hand-listed body and the export reader the same key", () => {
    const [fromBody] = buildMedicationImportEntries(MEDICATION_ID, [
      { datum: LOCAL_DATE, uhrzeit: LOCAL_TIME },
    ]);

    // The export names its instants with an explicit offset, so the same wall
    // time is written here with the local offset the body row implies.
    const stamp = `${LOCAL_DATE} ${LOCAL_TIME}:00 ${offsetSuffix(INSTANT)}`;
    const parsed = parseAutoExportCsv(
      `${CSV_HEADER}\n${stamp},${stamp},Ramipril,,1.0,1.0,count,Taken,No,\n`,
    );
    const plan = planAutoExportImport(parsed, [
      { id: MEDICATION_ID, name: "Ramipril", externalSource: null },
    ]);

    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].idempotencyKey).toBe(fromBody.idempotencyKey);
    expect(fromBody.idempotencyKey).toBe(
      medicationImportIdempotencyKey(MEDICATION_ID, INSTANT),
    );
  });
});
