/**
 * The staged Apple Health upload, from the request that writes it to the job
 * that consumes it, and what happens to it on every way out.
 *
 * The upload is the person's whole health export in plain text, written to
 * the shared temp directory by the kick-off request and read by the import
 * worker. Until v1.39.3 several exits left it there: a worker that was not
 * running (503), a queue that did not accept the job, an account deleted
 * before the worker reached it, and nothing ever swept what was left. Every
 * exit now removes it, and a periodic sweep removes anything older than the
 * longest an import may run, whatever left it.
 *
 * It also holds the rule of one running import per account. An import holds
 * the archive, the extracted XML (up to 8 GiB) and a worker slot; a second
 * one for the same account only doubles that and races the first on the same
 * rows. The check and the new row are one transaction under an advisory lock,
 * so two uploads that arrive together cannot both pass.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";

/** An import in one of these holds its staged files and a worker slot. */
export const ACTIVE_IMPORT_STATUSES = [
  "queued",
  "unpacking",
  "parsing",
  "upserting",
] as const;

/**
 * An active row older than this is not holding anything any more: the queue
 * expires an import after six hours (`APPLE_HEALTH_IMPORT_SEND_OPTIONS`) and
 * the reconcile pass fails it soon after. It must not block the account.
 */
const ACTIVE_IMPORT_MAX_AGE_MS = 7 * 60 * 60 * 1000;

/** Staged files older than this belong to no running import. */
export const STAGING_MAX_AGE_MS = ACTIVE_IMPORT_MAX_AGE_MS;

/** The names the kick-off and the extractor give their temp files. */
const STAGING_NAME =
  /^healthlog-(?:apple-health-import|admin-apple-health-import|upload)-[0-9a-f-]{36}\.bin$|^healthlog-import-[0-9a-f]{24}\.xml$/;

/** The error code a second concurrent import is refused with. */
export const IMPORT_BUSY_CODE = "import.apple_health.busy";

export type CreateImportJobResult =
  { created: { id: string } } | { busy: { id: string; status: string } };

/**
 * Create the ImportJob row unless the account already has an import running.
 * `data` is the row as the caller would create it.
 */
export async function createImportJobUnlessBusy(
  prisma: PrismaClient,
  data: Prisma.ImportJobUncheckedCreateInput,
  now: Date = new Date(),
): Promise<CreateImportJobResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`apple-health-import:${data.userId}`}))`;
    const running = await tx.importJob.findFirst({
      where: {
        userId: data.userId,
        status: { in: [...ACTIVE_IMPORT_STATUSES] },
        startedAt: { gte: new Date(now.getTime() - ACTIVE_IMPORT_MAX_AGE_MS) },
      },
      orderBy: { startedAt: "desc" },
      select: { id: true, status: true },
    });
    if (running) return { busy: running };
    const created = await tx.importJob.create({ data, select: { id: true } });
    return { created };
  });
}

/** Remove a staged file. Never throws; a file already gone is fine. */
export async function discardStagedUpload(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {});
}

/**
 * Remove staged uploads and extracted XML files older than
 * `STAGING_MAX_AGE_MS` from `dir`. Only names this app writes are touched.
 * Answers how many were removed.
 */
export async function sweepStaleImportStaging(
  dir: string = tmpdir(),
  now: number = Date.now(),
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!STAGING_NAME.test(name)) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      if (now - info.mtimeMs < STAGING_MAX_AGE_MS) continue;
      await rm(path, { force: true });
      removed++;
    } catch {
      // Gone between the listing and here, or not ours to remove.
    }
  }
  return removed;
}
