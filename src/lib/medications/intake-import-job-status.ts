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

export interface MedicationIntakeImportJobStatus {
  jobId: string;
  status: string;
  progress: Prisma.JsonValue;
  result: Prisma.JsonValue | null;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * Read one job the caller owns, or `null`.
 *
 * `medicationId` narrows to a job scoped to that medication; omit it for the
 * account-wide import. `userId` is always in the `where`, so a job id belonging
 * to somebody else is a 404 and not a leak.
 */
export async function readMedicationIntakeImportJob(
  userId: string,
  jobId: string,
  medicationId?: string,
): Promise<MedicationIntakeImportJobStatus | null> {
  const row = await prisma.medicationIntakeImportJob.findFirst({
    where: {
      id: jobId,
      userId,
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
    result: row.result,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}
