import { describe, expect, it } from "vitest";

import { MEDICATION_IMPORT_SKIP_DETAIL_LIMIT } from "@/lib/jobs/medication-intake-import";
import { projectMedicationImportResult } from "../intake-import-job-status";

describe("projectMedicationImportResult", () => {
  it("carries bounded line-and-reason detail and nothing else", () => {
    const projected = projectMedicationImportResult({
      imported: 0,
      skipped: 2,
      skipReasons: [{ reason: "already_recorded", count: 2 }],
      skipDetails: [
        {
          line: 7,
          reason: "already_recorded",
          medicationName: "SECRET MEDICATION",
          takenAt: "2026-07-01T08:00:00.000Z",
          credential: "token-secret",
        },
      ],
      skippedDetailsOmitted: 1,
      rawFile: "private health export",
    } as never);

    expect(projected).toEqual({
      imported: 0,
      skipped: 2,
      skipReasons: [{ reason: "already_recorded", count: 2 }],
      skipDetails: [{ line: 7, reason: "already_recorded" }],
      skippedDetailsOmitted: 1,
    });
    const wire = JSON.stringify(projected);
    expect(wire).not.toContain("SECRET MEDICATION");
    expect(wire).not.toContain("token-secret");
    expect(wire).not.toContain("private health export");
    expect(wire).not.toContain("takenAt");
  });

  it.each([
    {
      label: "unknown reason",
      result: {
        imported: 0,
        skipped: 1,
        skipReasons: [{ reason: "credential=secret", count: 1 }],
      },
    },
    {
      label: "health data in the reason count shape",
      result: {
        imported: 0,
        skipped: 1,
        skipReasons: [
          { reason: "already_recorded", count: 1, dose: "Mounjaro 15mg" },
        ],
        skipDetails: [{ line: 1, reason: "Mounjaro 15mg" }],
      },
    },
    {
      label: "more details than the cap",
      result: {
        imported: 0,
        skipped: MEDICATION_IMPORT_SKIP_DETAIL_LIMIT + 1,
        skipReasons: [
          {
            reason: "already_recorded",
            count: MEDICATION_IMPORT_SKIP_DETAIL_LIMIT + 1,
          },
        ],
        skipDetails: Array.from(
          { length: MEDICATION_IMPORT_SKIP_DETAIL_LIMIT + 1 },
          (_, index) => ({ line: index + 1, reason: "already_recorded" }),
        ),
      },
    },
  ])(
    "rejects a malformed $label result instead of leaking it",
    ({ result }) => {
      expect(projectMedicationImportResult(result as never)).toBeNull();
    },
  );
});
