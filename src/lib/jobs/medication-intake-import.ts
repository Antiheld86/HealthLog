import type { Job, JobWithMetadata } from "pg-boss";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { prisma, toJson } from "@/lib/db";
import { consumeImportedIntakesBatch } from "@/lib/medications/inventory/consumption";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import {
  dayKeyForScheduledFor,
  recomputeMedicationComplianceForDay,
} from "@/lib/rollups/medication-compliance-rollups";

export const MEDICATION_INTAKE_IMPORT_QUEUE = "medication-intake-import";
export const MEDICATION_INTAKE_IMPORT_CONCURRENCY = 2;
export const MEDICATION_INTAKE_IMPORT_CHUNK_SIZE = 100;
export const MEDICATION_INTAKE_IMPORT_ROLLUP_CHUNK_SIZE = 20;
export const MEDICATION_INTAKE_IMPORT_STALE_AFTER_MS = 15 * 60_000;

export const MEDICATION_INTAKE_IMPORT_SEND_OPTIONS = {
  retryLimit: 3,
  retryDelay: 15,
  retryBackoff: true,
  expireInSeconds: 60 * 60,
} as const;

export interface MedicationImportEntry {
  takenAt: string;
  idempotencyKey: string;
}

export interface MedicationImportPayload {
  entries: MedicationImportEntry[];
}

/**
 * Why a submitted entry did not become a row. Machine-readable; the client
 * turns each into a sentence.
 *
 * `duplicate_in_file` — two entries in the same submission resolve to the same
 * instant, so only one can be written.
 * `already_recorded` — the dose is already on the ledger for that instant, from
 * an earlier import or from any other intake surface.
 *
 * They used to be one `skippedDuplicates` number, which is how a file whose
 * every row collapsed onto one key could report "27 duplicates skipped" about
 * 27 doses that had no duplicate anywhere. Naming the reason is what makes the
 * count checkable against what the person actually submitted.
 */
export const MEDICATION_IMPORT_SKIP_REASONS = [
  "duplicate_in_file",
  "already_recorded",
] as const;

export type MedicationImportSkipReason =
  (typeof MEDICATION_IMPORT_SKIP_REASONS)[number];

/** Skip counts keyed by reason. A reason with no skips is absent, not zero. */
export type MedicationImportSkipCounts = Partial<
  Record<MedicationImportSkipReason, number>
>;

export interface MedicationImportProgress {
  processed: number;
  total: number;
  imported: number;
  skippedByReason: MedicationImportSkipCounts;
  touchedDays: string[];
  rollupProcessed: number;
}

export interface MedicationImportSkipGroup {
  reason: MedicationImportSkipReason;
  count: number;
}

export interface MedicationImportResult {
  imported: number;
  /** Total entries that did not become a row. */
  skipped: number;
  /**
   * One entry per reason, count descending then reason — never the same
   * sentence repeated per row. Empty when nothing was skipped.
   */
  skipReasons: MedicationImportSkipGroup[];
}

/** Collapse the running counts into the wire shape, in a stable order. */
export function groupMedicationImportSkips(
  counts: MedicationImportSkipCounts,
): MedicationImportSkipGroup[] {
  return MEDICATION_IMPORT_SKIP_REASONS.map((reason) => ({
    reason,
    count: counts[reason] ?? 0,
  }))
    .filter((group) => group.count > 0)
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Total skipped across every reason. */
export function totalMedicationImportSkips(
  counts: MedicationImportSkipCounts,
): number {
  return MEDICATION_IMPORT_SKIP_REASONS.reduce(
    (sum, reason) => sum + (counts[reason] ?? 0),
    0,
  );
}

export interface MedicationIntakeImportQueuePayload {
  jobId: string;
}

export interface MedicationImportChunkResult {
  from: number;
  processed: number;
  imported: number;
  skippedByReason: MedicationImportSkipCounts;
  touchedDays: string[];
}

let workerPrismaSingleton: PrismaClient | null = null;

export function _setMedicationIntakeImportPrismaForTests(
  client: PrismaClient | null,
): void {
  workerPrismaSingleton = client;
}

function getWorkerPrisma(): PrismaClient {
  return workerPrismaSingleton ?? prisma;
}

export function medicationImportChunk<T>(
  entries: readonly T[],
  cursor: number,
): T[] {
  const start = Math.max(0, Math.trunc(cursor));
  return entries.slice(start, start + MEDICATION_INTAKE_IMPORT_CHUNK_SIZE);
}

export function advanceMedicationImportProgress(
  previous: MedicationImportProgress,
  chunk: MedicationImportChunkResult,
): MedicationImportProgress {
  if (chunk.from !== previous.processed) return previous;

  const processed = Math.min(
    previous.total,
    previous.processed + Math.max(0, Math.trunc(chunk.processed)),
  );
  const touchedDays = [...previous.touchedDays];
  const seenDays = new Set(touchedDays);
  for (const day of chunk.touchedDays) {
    if (!seenDays.has(day)) {
      seenDays.add(day);
      touchedDays.push(day);
    }
  }

  const skippedByReason: MedicationImportSkipCounts = {
    ...previous.skippedByReason,
  };
  for (const reason of MEDICATION_IMPORT_SKIP_REASONS) {
    const added = Math.max(0, Math.trunc(chunk.skippedByReason[reason] ?? 0));
    if (added === 0) continue;
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + added;
  }

  return {
    processed,
    total: previous.total,
    imported: previous.imported + Math.max(0, Math.trunc(chunk.imported)),
    skippedByReason,
    rollupProcessed: previous.rollupProcessed,
    touchedDays,
  };
}

export function sanitiseMedicationImportFailure(error: unknown): string {
  void error;
  return "Medication intake import failed";
}

function parsePayload(value: Prisma.JsonValue): MedicationImportPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("entries" in value) ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("Medication intake import payload is malformed");
  }

  const entries = value.entries.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof entry.takenAt !== "string" ||
      !Number.isFinite(Date.parse(entry.takenAt)) ||
      typeof entry.idempotencyKey !== "string" ||
      entry.idempotencyKey.length === 0
    ) {
      throw new Error("Medication intake import entry is malformed");
    }
    return {
      takenAt: entry.takenAt,
      idempotencyKey: entry.idempotencyKey,
    };
  });
  return { entries };
}

/**
 * Read the persisted skip counts. Strict, like every other field of the
 * progress blob: an unknown reason key or a non-integer count means the row was
 * not written by this code, and the job fails rather than reporting a number it
 * cannot stand behind. Returns null on anything malformed.
 */
function parseSkipCounts(
  value: Prisma.JsonValue | undefined,
): MedicationImportSkipCounts | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const counts: MedicationImportSkipCounts = {};
  for (const [key, raw] of Object.entries(value)) {
    if (
      !(MEDICATION_IMPORT_SKIP_REASONS as readonly string[]).includes(key) ||
      typeof raw !== "number" ||
      !Number.isInteger(raw) ||
      raw < 0
    ) {
      return null;
    }
    counts[key as MedicationImportSkipReason] = raw;
  }
  return counts;
}

function parseProgress(
  value: Prisma.JsonValue,
  total: number,
): MedicationImportProgress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Medication intake import progress is malformed");
  }
  const processed = Number(value.processed);
  const imported = Number(value.imported);
  const skippedByReason = parseSkipCounts(value.skippedByReason);
  const rawTouchedDays = value.touchedDays;
  const touchedDays =
    Array.isArray(rawTouchedDays) &&
    rawTouchedDays.every((day): day is string => typeof day === "string")
      ? [...new Set(rawTouchedDays)]
      : null;
  const rollupProcessed =
    value.rollupProcessed === undefined ? 0 : Number(value.rollupProcessed);
  if (
    !Number.isInteger(processed) ||
    processed < 0 ||
    processed > total ||
    !Number.isInteger(imported) ||
    imported < 0 ||
    skippedByReason === null ||
    touchedDays === null ||
    !Number.isInteger(rollupProcessed) ||
    rollupProcessed < 0 ||
    rollupProcessed > (touchedDays?.length ?? 0)
  ) {
    throw new Error("Medication intake import progress is malformed");
  }
  return {
    processed,
    total,
    imported,
    skippedByReason,
    touchedDays,
    rollupProcessed,
  };
}

interface ProcessChunkOutcome {
  terminal: boolean;
  finalized: boolean;
  result: MedicationImportResult | null;
  userId: string | null;
}

async function recomputeTouchedDays(
  client: Pick<PrismaClient, "$executeRaw">,
  userId: string,
  medicationId: string,
  timezone: string,
  days: readonly string[],
): Promise<void> {
  await Promise.all(
    days.map((day) =>
      recomputeMedicationComplianceForDay(
        userId,
        medicationId,
        day,
        timezone,
        client,
      ),
    ),
  );
}

async function processNextChunk(
  client: PrismaClient,
  jobId: string,
): Promise<ProcessChunkOutcome> {
  return client.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "medication_intake_import_jobs"
        WHERE "id" = ${jobId}
        FOR UPDATE
      `;
      if (locked.length === 0) {
        return {
          terminal: true,
          finalized: false,
          result: null,
          userId: null,
        };
      }

      const row = await tx.medicationIntakeImportJob.findUnique({
        where: { id: jobId },
        include: { user: { select: { timezone: true } } },
      });
      if (!row || row.status === "done" || row.status === "failed") {
        return {
          terminal: true,
          finalized: false,
          result: null,
          userId: row?.userId ?? null,
        };
      }

      const payload = parsePayload(row.payload);
      const progress = parseProgress(row.progress, payload.entries.length);
      if (progress.processed >= progress.total) {
        const rollupDays = progress.touchedDays.slice(
          progress.rollupProcessed,
          progress.rollupProcessed + MEDICATION_INTAKE_IMPORT_ROLLUP_CHUNK_SIZE,
        );
        await recomputeTouchedDays(
          tx,
          row.userId,
          row.medicationId,
          row.user.timezone,
          rollupDays,
        );
        const finalizedProgress: MedicationImportProgress = {
          ...progress,
          rollupProcessed: progress.rollupProcessed + rollupDays.length,
        };
        if (finalizedProgress.rollupProcessed < progress.touchedDays.length) {
          const heartbeatAt = new Date();
          await tx.medicationIntakeImportJob.update({
            where: { id: row.id },
            data: {
              status: "running",
              progress: toJson(finalizedProgress),
              heartbeatAt,
              startedAt: row.startedAt ?? heartbeatAt,
              failureReason: null,
            },
          });
          return {
            terminal: false,
            finalized: false,
            result: null,
            userId: row.userId,
          };
        }
        const result: MedicationImportResult = {
          imported: progress.imported,
          skipped: totalMedicationImportSkips(progress.skippedByReason),
          skipReasons: groupMedicationImportSkips(progress.skippedByReason),
        };
        const completedAt = new Date();
        await tx.auditLog.create({
          data: {
            userId: row.userId,
            action: "medication.intake.import",
            details: JSON.stringify({
              jobId: row.id,
              medicationId: row.medicationId,
              imported: result.imported,
              skipped: result.skipped,
              skipReasons: result.skipReasons,
              total: progress.total,
            }),
          },
        });
        await tx.medicationIntakeImportJob.update({
          where: { id: row.id },
          data: {
            status: "done",
            result: toJson(result),
            progress: toJson(finalizedProgress),
            failureReason: null,
            heartbeatAt: completedAt,
            completedAt,
          },
        });
        return {
          terminal: true,
          finalized: true,
          result,
          userId: row.userId,
        };
      }

      const entries = medicationImportChunk(
        payload.entries,
        progress.processed,
      );
      const uniqueEntries = [
        ...new Map(
          entries.map((entry) => [entry.idempotencyKey, entry]),
        ).values(),
      ];
      const created = await tx.medicationIntakeEvent.createManyAndReturn({
        data: uniqueEntries.map((entry) => {
          const takenAt = new Date(entry.takenAt);
          return {
            userId: row.userId,
            medicationId: row.medicationId,
            scheduledFor: takenAt,
            takenAt,
            skipped: false,
            source: "IMPORT" as const,
            idempotencyKey: entry.idempotencyKey,
          };
        }),
        skipDuplicates: true,
        select: { id: true, takenAt: true, scheduledFor: true },
      });

      await consumeImportedIntakesBatch({
        client: tx,
        userId: row.userId,
        medicationId: row.medicationId,
        events: created.map((event) => ({
          eventId: event.id,
          intakeAt: event.takenAt ?? event.scheduledFor,
        })),
      });

      const touchedDays = created.map((event) =>
        dayKeyForScheduledFor(event.scheduledFor, row.user.timezone),
      );
      // Two different facts, counted apart. The Map collapse above is entries
      // of this submission that resolve to the same instant; `skipDuplicates`
      // then drops whatever the ledger already holds for that instant, from an
      // earlier import or any other intake surface. Reporting both as one
      // "duplicates" number is what let a whole month of distinct doses read
      // as duplicates of each other.
      const nextProgress = advanceMedicationImportProgress(progress, {
        from: progress.processed,
        processed: entries.length,
        imported: created.length,
        skippedByReason: {
          duplicate_in_file: entries.length - uniqueEntries.length,
          already_recorded: uniqueEntries.length - created.length,
        },
        touchedDays,
      });
      const heartbeatAt = new Date();
      await tx.medicationIntakeImportJob.update({
        where: { id: row.id },
        data: {
          status: "running",
          progress: toJson(nextProgress),
          heartbeatAt,
          startedAt: row.startedAt ?? heartbeatAt,
          failureReason: null,
        },
      });
      return {
        terminal: false,
        finalized: false,
        result: null,
        userId: row.userId,
      };
    },
    { timeout: 60_000 },
  );
}

export async function processMedicationIntakeImportJob(
  jobId: string,
): Promise<MedicationImportResult | null> {
  const client = getWorkerPrisma();
  for (;;) {
    const outcome = await processNextChunk(client, jobId);
    if (!outcome.terminal) continue;
    if (outcome.finalized && outcome.userId && outcome.result) {
      if (outcome.result.imported > 0) {
        invalidateUserMedications(outcome.userId, { evict: true });
        queueMedicationIntakeSync({ userId: outcome.userId });
      }
      return outcome.result;
    }
    return null;
  }
}

async function recordWorkerFailure(
  job: Job<MedicationIntakeImportQueuePayload>,
  error: unknown,
): Promise<void> {
  const client = getWorkerPrisma();
  const metadata = job as Partial<
    JobWithMetadata<MedicationIntakeImportQueuePayload>
  >;
  const retryCount = metadata.retryCount ?? 0;
  const retryLimit = metadata.retryLimit ?? 0;
  const terminal = retryCount >= retryLimit;
  const now = new Date();
  await client.medicationIntakeImportJob.updateMany({
    where: {
      id: job.data.jobId,
      status: { notIn: ["done", "failed"] },
    },
    data: terminal
      ? {
          status: "failed",
          failureReason: sanitiseMedicationImportFailure(error),
          heartbeatAt: now,
          completedAt: now,
        }
      : {
          status: "queued",
          failureReason: null,
          heartbeatAt: now,
        },
  });
}

export async function handleMedicationIntakeImport(
  job: Job<MedicationIntakeImportQueuePayload>,
): Promise<void> {
  try {
    await processMedicationIntakeImportJob(job.data.jobId);
  } catch (error) {
    await recordWorkerFailure(job, error);
    throw error;
  }
}
