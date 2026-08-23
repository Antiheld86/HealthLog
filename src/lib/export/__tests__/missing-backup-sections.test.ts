/**
 * A missing section and a declared omission are not the same thing.
 *
 * `findMissingBackupSections` is the rule that separates them, and the whole
 * value of the refusal it feeds rests on it getting the separation right in
 * both directions:
 *
 *   - too lax and a portable file whose documents section is gone still runs,
 *     which is the defect (#237) — the restore deletes the vault it is about to
 *     rebuild and rebuilds nothing;
 *   - too strict and it refuses the two files that legitimately leave a section
 *     out. The portable export omits the mental-health screeners and the consent
 *     receipts ON PURPOSE, declares both in the manifest as `included:
 *     "omitted"`, and has to stay restorable. So does every backup written
 *     before the manifest existed, which declares nothing at all.
 *
 * The manifest is the only discriminator, and the cases below say so by proving
 * the two things it is NOT: not the emptiness of the array (an account with no
 * documents honestly writes `[]`), and not a guess from the export's purpose,
 * which the payload never states.
 *
 * Mutation check: treat `[]` as missing and the empty-section case goes red;
 * drop the `included === "omitted"` skip and the declared-omission case goes
 * red; return early on a present-but-manifest-less file and the legacy case
 * stays green while the first case goes red.
 */
import { describe, expect, it } from "vitest";

import { findMissingBackupSections } from "../restore-skips";

/** A portable file's manifest, as `buildFullBackupPayload` writes it. */
const PORTABLE_MANIFEST = {
  documents: { included: "metadata-only", note: "…" },
  workouts: { included: "summary-only", note: "…" },
  mentalHealth: { included: "omitted", note: "…" },
  consent: { included: "omitted", note: "…" },
};

/** The disaster-recovery writer's manifest — every section carried. */
const DR_MANIFEST = {
  documents: { included: "encrypted-content", note: "…" },
  workouts: { included: "summary-only", note: "…" },
  mentalHealth: { included: "full", note: "…" },
  consent: { included: "full", note: "…" },
};

function portable(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "2",
    exportedAt: "2026-08-01T00:00:00.000Z",
    userId: "user-1",
    manifest: PORTABLE_MANIFEST,
    documents: [],
    workouts: [],
    mentalHealthAssessments: [],
    consentReceipts: [],
    ...overrides,
  };
}

describe("findMissingBackupSections", () => {
  it("names the documents section a portable file claims and does not carry", () => {
    const file = portable();
    delete (file as Record<string, unknown>).documents;

    expect(findMissingBackupSections(file)).toEqual(["documents"]);
  });

  it("finds nothing in a complete portable file", () => {
    expect(findMissingBackupSections(portable())).toEqual([]);
  });

  it("does not read an empty section as a missing one", () => {
    // An account with no documents writes `[]`, and that file is fine. Refusing
    // it would make the check worse than the silence it replaces.
    expect(findMissingBackupSections(portable({ documents: [] }))).toEqual([]);
  });

  it("leaves a DECLARED omission alone", () => {
    // The portable export omits both of these on purpose and says so. This is
    // the boundary: the keys are gone, and the file is still restorable.
    const file = portable();
    delete (file as Record<string, unknown>).mentalHealthAssessments;
    delete (file as Record<string, unknown>).consentReceipts;

    expect(findMissingBackupSections(file)).toEqual([]);
  });

  it("names the same two sections when the manifest says they ARE carried", () => {
    // Identical payload to the case above, one word different in the manifest.
    // That word is the whole rule.
    const file = portable({ manifest: DR_MANIFEST });
    delete (file as Record<string, unknown>).mentalHealthAssessments;
    delete (file as Record<string, unknown>).consentReceipts;

    expect(findMissingBackupSections(file)).toEqual([
      "mentalHealth",
      "consent",
    ]);
  });

  it("claims nothing about a file with no manifest", () => {
    // Every backup written before the manifest existed. It declares nothing, so
    // nothing is missing from it, and it stays restorable.
    const legacy = portable({ manifest: null });
    delete (legacy as Record<string, unknown>).documents;
    delete (legacy as Record<string, unknown>).workouts;

    expect(findMissingBackupSections(legacy)).toEqual([]);
  });

  it("reports every missing section rather than the first", () => {
    const file = portable({ manifest: DR_MANIFEST });
    delete (file as Record<string, unknown>).documents;
    delete (file as Record<string, unknown>).workouts;

    expect(findMissingBackupSections(file)).toEqual(["documents", "workouts"]);
  });

  it("survives a payload that is not an object at all", () => {
    expect(findMissingBackupSections(null)).toEqual([]);
    expect(findMissingBackupSections("nope")).toEqual([]);
    expect(findMissingBackupSections([])).toEqual([]);
  });
});
