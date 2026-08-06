import { describe, expect, it } from "vitest";

import {
  MEDICATION_IMPORT_SKIP_DETAIL_LIMIT,
  MEDICATION_INTAKE_IMPORT_CHUNK_SIZE,
  MEDICATION_INTAKE_IMPORT_ROLLUP_CHUNK_SIZE,
  _setMedicationIntakeImportPrismaForTests,
  advanceMedicationImportProgress,
  appendMedicationImportSkipDetails,
  groupMedicationImportSkips,
  medicationImportChunk,
  processMedicationIntakeImportJob,
  sanitiseMedicationImportFailure,
  totalMedicationImportSkips,
  type MedicationImportProgress,
} from "@/lib/jobs/medication-intake-import";

const INITIAL: MedicationImportProgress = {
  processed: 0,
  total: 1_000,
  imported: 0,
  skippedByReason: {},
  touchedDays: [],
  rollupProcessed: 0,
};

describe("medication intake import worker bounds", () => {
  it("never exposes more than the configured chunk-size to one transaction", () => {
    const entries = Array.from({ length: 1_000 }, (_, index) => ({ index }));
    let cursor = 0;
    const observed: number[] = [];

    while (cursor < entries.length) {
      const chunk = medicationImportChunk(entries, cursor);
      observed.push(chunk.length);
      cursor += chunk.length;
    }

    expect(MEDICATION_INTAKE_IMPORT_CHUNK_SIZE).toBeGreaterThan(0);
    expect(MEDICATION_INTAKE_IMPORT_CHUNK_SIZE).toBeLessThanOrEqual(100);
    expect(Math.max(...observed)).toBe(MEDICATION_INTAKE_IMPORT_CHUNK_SIZE);
    expect(observed.reduce((sum, size) => sum + size, 0)).toBe(1_000);
  });

  it("advances progress monotonically and ignores a stale replay", () => {
    const first = advanceMedicationImportProgress(INITIAL, {
      from: 0,
      processed: 100,
      imported: 98,
      skippedByReason: { duplicate_in_file: 2 },
      touchedDays: ["2026-07-20", "2026-07-21"],
    });
    const second = advanceMedicationImportProgress(first, {
      from: 100,
      processed: 100,
      imported: 97,
      skippedByReason: { duplicate_in_file: 1, already_recorded: 2 },
      touchedDays: ["2026-07-21", "2026-07-22"],
    });
    const replay = advanceMedicationImportProgress(second, {
      from: 0,
      processed: 100,
      imported: 98,
      skippedByReason: { duplicate_in_file: 2 },
      touchedDays: ["2026-07-20"],
    });

    expect(first.processed).toBe(100);
    expect(second).toEqual({
      processed: 200,
      total: 1_000,
      imported: 195,
      skippedByReason: { duplicate_in_file: 3, already_recorded: 2 },
      touchedDays: ["2026-07-20", "2026-07-21", "2026-07-22"],
      rollupProcessed: 0,
    });
    expect(replay).toBe(second);
  });

  it("stores a bounded generic failure instead of an internal error", () => {
    const internal = new Error(
      "postgres://queue-user:secret@example.test medication payload leaked",
    );

    const failure = sanitiseMedicationImportFailure(internal);

    expect(failure).toBe("Medication intake import failed");
    expect(failure).not.toContain("secret");
    expect(failure.length).toBeLessThanOrEqual(1_000);
  });

  it("checkpoints bounded rollup transactions across many touched days", async () => {
    const touchedDays = Array.from({ length: 1_000 }, (_, index) =>
      new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
    );
    let persistedProgress: unknown = {
      processed: 0,
      total: 0,
      imported: 0,
      skippedByReason: {},
      touchedDays,
    };
    let status = "running";
    const executeRawCounts: number[] = [];
    let auditCount = 0;
    let transactionNumber = 0;
    let rejectRollup = true;

    const client = {
      $transaction: async (
        operation: (tx: Record<string, unknown>) => Promise<unknown>,
      ) => {
        transactionNumber += 1;
        let executeRawCount = 0;
        const tx = {
          $queryRaw: async () => [{ id: "job-many-days" }],
          $executeRaw: async () => {
            executeRawCount += 1;
            if (rejectRollup && transactionNumber === 3) {
              rejectRollup = false;
              throw new Error("rollup transaction failed");
            }
            return 1;
          },
          medicationIntakeImportJob: {
            findUnique: async () => ({
              id: "job-many-days",
              recordUserId: "user-1",
              actorUserId: "user-1",
              medicationId: "medication-1",
              status,
              payload: { entries: [] },
              progress: persistedProgress,
              startedAt: new Date(),
              recordUser: { timezone: "UTC" },
            }),
            update: async (args: {
              data: { progress?: unknown; status?: string };
            }) => {
              if (args.data.progress !== undefined) {
                persistedProgress = args.data.progress;
              }
              if (args.data.status !== undefined) status = args.data.status;
              return {};
            },
          },
          auditLog: {
            create: async () => {
              auditCount += 1;
              return {};
            },
          },
        };
        try {
          return await operation(tx);
        } finally {
          executeRawCounts.push(executeRawCount);
        }
      },
    };

    _setMedicationIntakeImportPrismaForTests(client as never);
    try {
      await expect(
        processMedicationIntakeImportJob("job-many-days"),
      ).rejects.toThrow("rollup transaction failed");
      expect(persistedProgress).toMatchObject({
        rollupProcessed: MEDICATION_INTAKE_IMPORT_ROLLUP_CHUNK_SIZE * 2,
      });
      expect(status).toBe("running");
      expect(auditCount).toBe(0);

      await processMedicationIntakeImportJob("job-many-days");
    } finally {
      _setMedicationIntakeImportPrismaForTests(null);
    }

    expect(executeRawCounts).toHaveLength(
      Math.ceil(
        touchedDays.length / MEDICATION_INTAKE_IMPORT_ROLLUP_CHUNK_SIZE,
      ) + 1,
    );
    expect(Math.max(...executeRawCounts)).toBeLessThanOrEqual(
      MEDICATION_INTAKE_IMPORT_ROLLUP_CHUNK_SIZE * 2,
    );
    expect(status).toBe("done");
    expect(persistedProgress).toMatchObject({
      rollupProcessed: touchedDays.length,
    });
    expect(auditCount).toBe(1);
  });
});

describe("medication import skip reporting (#650)", () => {
  it("reports one entry per reason, count descending, and omits zero", () => {
    expect(
      groupMedicationImportSkips({
        duplicate_in_file: 2,
        already_recorded: 9,
      }),
    ).toEqual([
      { reason: "already_recorded", count: 9 },
      { reason: "duplicate_in_file", count: 2 },
    ]);
    expect(
      groupMedicationImportSkips({
        duplicate_in_file: 0,
        already_recorded: 4,
      }),
    ).toEqual([{ reason: "already_recorded", count: 4 }]);
    expect(groupMedicationImportSkips({})).toEqual([]);
  });

  it("totals every reason so the headline count matches the groups", () => {
    const counts = { duplicate_in_file: 2, already_recorded: 9 };
    expect(totalMedicationImportSkips(counts)).toBe(11);
    expect(
      groupMedicationImportSkips(counts).reduce(
        (sum, group) => sum + group.count,
        0,
      ),
    ).toBe(totalMedicationImportSkips(counts));
    expect(totalMedicationImportSkips({})).toBe(0);
  });

  it("keeps the two reasons apart while accumulating across chunks", () => {
    const first = advanceMedicationImportProgress(INITIAL, {
      from: 0,
      processed: 100,
      imported: 90,
      skippedByReason: { duplicate_in_file: 10 },
      touchedDays: [],
    });
    const second = advanceMedicationImportProgress(first, {
      from: 100,
      processed: 100,
      imported: 95,
      skippedByReason: { already_recorded: 5 },
      touchedDays: [],
    });

    expect(second.skippedByReason).toEqual({
      duplicate_in_file: 10,
      already_recorded: 5,
    });
    expect(groupMedicationImportSkips(second.skippedByReason)).toEqual([
      { reason: "duplicate_in_file", count: 10 },
      { reason: "already_recorded", count: 5 },
    ]);
  });

  it("bounds retained row detail and counts the remainder", () => {
    const details = Array.from(
      { length: MEDICATION_IMPORT_SKIP_DETAIL_LIMIT + 37 },
      (_, index) => ({
        line: index + 1,
        reason: "already_recorded" as const,
      }),
    );
    const accumulated = appendMedicationImportSkipDetails(
      { skipDetails: [], skippedDetailsOmitted: 0 },
      details,
    );

    expect(accumulated.skipDetails).toHaveLength(
      MEDICATION_IMPORT_SKIP_DETAIL_LIMIT,
    );
    expect(accumulated.skippedDetailsOmitted).toBe(37);
    expect(Buffer.byteLength(JSON.stringify(accumulated), "utf8")).toBeLessThan(
      16 * 1024,
    );
  });
});
