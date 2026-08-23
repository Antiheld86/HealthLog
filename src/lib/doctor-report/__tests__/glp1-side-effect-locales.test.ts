/**
 * The GLP-1 block of the doctor report must tally a side effect the same way
 * whatever language the patient recorded it in.
 *
 * It did not. The tally matched the stored tag string against a hand-written
 * English/German word list, so a clinician reading a French, Spanish, Italian
 * or Polish patient's report saw an empty side-effect table over a record that
 * had three months of them — and nothing on the page said the table was a
 * filter rather than the truth.
 */
import { describe, expect, it } from "vitest";

import { buildGlp1Block } from "../medications";
import type { MedicationRowForReport } from "../medications";

const MED: MedicationRowForReport = {
  id: "med-1",
  name: "Mounjaro",
  dose: "7.5 mg",
  treatmentClass: "GLP1",
  doseChanges: [
    {
      effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
      doseValue: 7.5,
      doseUnit: "mg",
      note: null,
      noteEncrypted: null,
    },
  ],
  intakeEvents: [],
} as unknown as MedicationRowForReport;

function block(tagRows: string[]) {
  return buildGlp1Block({
    medications: [MED],
    compliance: {},
    weightSeries: [],
    moodTagRows: tagRows.map((tags) => ({ tags })),
  });
}

describe("doctor report GLP-1 side-effect tally across locales", () => {
  it("tallies the French chip label exactly as the English one", () => {
    const en = block([JSON.stringify(["nausea", "headache"])]);
    const fr = block([JSON.stringify(["Nausées", "Maux de tête"])]);
    expect(fr?.sideEffects).toEqual(en?.sideEffects);
    expect(fr?.sideEffects).toEqual([
      { tag: "nausea", count: 1 },
      { tag: "headache", count: 1 },
    ]);
  });

  it("tallies Spanish, Italian and Polish chip labels", () => {
    expect(block([JSON.stringify(["Estreñimiento"])])?.sideEffects).toEqual([
      { tag: "constipation", count: 1 },
    ]);
    expect(block([JSON.stringify(["Affaticamento"])])?.sideEffects).toEqual([
      { tag: "fatigue", count: 1 },
    ]);
    expect(block([JSON.stringify(["Zgaga"])])?.sideEffects).toEqual([
      { tag: "heartburn", count: 1 },
    ]);
  });

  it("adds up one symptom recorded in several languages", () => {
    // An account that switched UI language mid-therapy holds both spellings.
    // They are one symptom and must count as three days of it, not as two
    // unrelated rows or one.
    const out = block([
      JSON.stringify(["nausea"]),
      JSON.stringify(["Übelkeit"]),
      JSON.stringify(["Nudności"]),
    ]);
    expect(out?.sideEffects).toEqual([{ tag: "nausea", count: 3 }]);
  });

  it("still refuses free text, so no invented symptom reaches a clinician", () => {
    expect(
      block([JSON.stringify(["gym", "date night", "Feierabend"])])?.sideEffects,
    ).toEqual([]);
  });
});
