/**
 * The one projection of an intake-import job onto the polling response.
 *
 * Two routes read it — the per-medication import under `/api/medications/[id]/…`
 * and the account-wide export import — and the client polls both through the
 * same helper. Restating the field list per route is how one of them ends up
 * omitting `failureReason` and a failed run reads as a run still going.
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  MEDICATION_IMPORT_SKIP_REASONS,
  parseMedicationImportSkipDetails,
  type MedicationImportResult,
} from "@/lib/jobs/medication-intake-import";

export interface MedicationIntakeImportJobStatus {
  jobId: string;
  status: string;
  progress: Prisma.JsonValue;
  result: MedicationImportResult | null;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * Project the persisted result through a strict allowlist before it reaches a
 * polling response. A compromised or legacy JSON blob cannot smuggle raw file
 * data, credentials, medication names, timestamps or arbitrary error prose.
 */
export function projectMedicationImportResult(
  value: Prisma.JsonValue | null,
): MedicationImportResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const imported = Number(value.imported);
  const skipped = Number(value.skipped);
  if (
    !Number.isInteger(imported) ||
    imported < 0 ||
    !Number.isInteger(skipped) ||
    skipped < 0 ||
    !Array.isArray(value.skipReasons)
  ) {
    return null;
  }
  const skipReasons = value.skipReasons.flatMap((group) => {
    if (
      typeof group !== "object" ||
      group === null ||
      Array.isArray(group) ||
      typeof group.reason !== "string" ||
      !(MEDICATION_IMPORT_SKIP_REASONS as readonly string[]).includes(
        group.reason,
      ) ||
      !Number.isInteger(group.count) ||
      Number(group.count) < 1
    ) {
      return [];
    }
    return [
      {
        reason: group.reason as (typeof MEDICATION_IMPORT_SKIP_REASONS)[number],
        count: Number(group.count),
      },
    ];
  });
  if (
    skipReasons.length !== value.skipReasons.length ||
    skipReasons.reduce((sum, group) => sum + group.count, 0) !== skipped
  ) {
    return null;
  }

  const rawDetails = value.skipDetails;
  const skipDetails =
    rawDetails === undefined
      ? undefined
      : parseMedicationImportSkipDetails(rawDetails);
  const skippedDetailsOmitted =
    value.skippedDetailsOmitted === undefined
      ? undefined
      : Number(value.skippedDetailsOmitted);
  if (
    (rawDetails !== undefined && skipDetails === null) ||
    (skippedDetailsOmitted !== undefined &&
      (!Number.isInteger(skippedDetailsOmitted) ||
        skippedDetailsOmitted < 0)) ||
    (skipDetails?.length ?? 0) + (skippedDetailsOmitted ?? 0) > skipped
  ) {
    return null;
  }

  return {
    imported,
    skipped,
    skipReasons,
    ...(skipDetails === undefined || skipDetails === null
      ? {}
      : { skipDetails }),
    ...(skippedDetailsOmitted === undefined ? {} : { skippedDetailsOmitted }),
  };
}

/**
 * Read one job the caller owns, or `null`.
 *
 * `medicationId` narrows to a job scoped to that medication; omit it for the
 * account-wide import. `recordUserId` is always in the `where`, so a job id belonging
 * to somebody else is a 404 and not a leak.
 */
export async function readMedicationIntakeImportJob(
  recordUserId: string,
  jobId: string,
  medicationId?: string,
): Promise<MedicationIntakeImportJobStatus | null> {
  const row = await prisma.medicationIntakeImportJob.findFirst({
    where: {
      id: jobId,
      recordUserId,
      // An account-wide job carries no medication, and asking for one by id must
      // not resolve to the other kind. `null` is the explicit narrowing.
      medicationId: medicationId ?? null,
    },
  });
  if (!row) return null;
  return {
    jobId: row.id,
    status: row.status,
    progress: row.progress,
    result: projectMedicationImportResult(row.result),
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}
