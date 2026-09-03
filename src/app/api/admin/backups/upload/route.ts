/**
 * POST /api/admin/backups/upload — admin-only ingest of a backup file.
 *
 * Accepts a `multipart/form-data` body with a single `file` field that
 * carries a JSON backup matching `backupPayloadSchema`. The route:
 *
 *   1. Authenticates the caller as an admin (cookie session only).
 *   2. Reads the file (size capped — see `MAX_UPLOAD_BYTES`).
 *   3. Parses and validates the JSON against the canonical schema.
 *   4. Rejects files written by a future schema version (incompatible).
 *   5. Encrypts the plaintext and inserts a new `DataBackup` row of
 *      type `MANUAL_UPLOAD_<unix-ms>` so multiple uploads coexist with
 *      the rolling `WEEKLY_AUTO` snapshot AND with each other.
 *
 * Crucially, this route does NOT execute a restore. It only stores the
 * file. The separate `POST /api/admin/backups/[id]/restore` endpoint
 * (criterion 3) actually replaces user data — keeping the two phases
 * apart is the whole reason an admin can review what they uploaded
 * before pulling the trigger.
 *
 * Phase B1 / criterion 2 of the v1.4.15 backup-completeness work.
 */
import { NextRequest } from "next/server";
import { ZodError } from "zod/v4";
import { prisma } from "@/lib/db";
import { apiHandler, HttpError, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { packBackupBlob } from "@/lib/export/backup-blob";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  backupPayloadSchema,
  isCompatibleSchemaVersion,
  summarizeBackup,
  type BackupSummary,
} from "@/lib/validations/backup";

export const dynamic = "force-dynamic";

/**
 * Cap on uploaded file size. The largest production backups today are
 * ~2 MB; 10 MB leaves headroom while keeping a malicious admin client
 * from blowing memory by streaming a 4 GB file. Enforced by reading the
 * `Content-Length` header AND the actual buffered size after decoding —
 * a missing/wrong content-length doesn't bypass the limit.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface UploadResponse {
  id: string;
  valid: true;
  summary: BackupSummary;
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { user: admin } = await requireAdmin();
  annotate({ action: { name: "admin.backups.upload" } });

  // Rate-limit identical to the manual-run endpoint. An admin uploading
  // a 10 MB blob 60× per minute would just be wasteful — three is plenty
  // for a deliberate restore-prep workflow.
  const rl = await checkRateLimit(
    `admin-backups-upload:${admin.id}`,
    3,
    60 * 1000,
  );
  if (!rl.allowed) {
    throw new HttpError(429, "Too many backup uploads");
  }

  // Cheap pre-flight on the declared content length. The actual buffer
  // size check below is the hard limit; this just rejects obvious abuse
  // before allocating the FormData parser.
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_UPLOAD_BYTES) {
    await auditLog("admin.backups.upload.denied", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: { reason: "content_length_exceeded", contentLength },
    });
    return apiError("Upload exceeds 10 MB limit", 413);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (err) {
    return apiError(
      `Invalid multipart body: ${err instanceof Error ? err.message : "unknown"}`,
      400,
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return apiError("Field 'file' must be a file", 422);
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    await auditLog("admin.backups.upload.denied", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: { reason: "file_size_exceeded", size: file.size },
    });
    return apiError("Upload exceeds 10 MB limit", 413);
  }

  let plaintext: string;
  try {
    plaintext = await file.text();
  } catch {
    return apiError("Failed to read uploaded file", 400);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(plaintext);
  } catch (err) {
    await auditLog("admin.backups.upload.denied", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: {
        reason: "invalid_json",
        message: err instanceof Error ? err.message : "parse_failed",
      },
    });
    return apiError("Uploaded file is not valid JSON", 422);
  }

  let payload;
  try {
    payload = backupPayloadSchema.parse(parsedJson);
  } catch (err) {
    const issues =
      err instanceof ZodError
        ? err.issues.slice(0, 10).map((i) => ({
            path: i.path.join("."),
            message: i.message,
          }))
        : [];
    await auditLog("admin.backups.upload.denied", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: { reason: "schema_invalid", issues },
    });
    return apiError("Backup payload failed schema validation", 422, {
      issues,
    });
  }

  if (!isCompatibleSchemaVersion(payload.schemaVersion)) {
    await auditLog("admin.backups.upload.denied", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: {
        reason: "incompatible_schema_version",
        schemaVersion: payload.schemaVersion,
      },
    });
    return apiError(
      `Backup schema version '${payload.schemaVersion}' is not supported by this server`,
      422,
    );
  }

  // Make sure the userId on the file points at a user that exists in
  // this DB. Restore would fail later anyway, but failing here gives
  // the admin a precise error before any side-effect.
  const owner = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, username: true },
  });
  if (!owner) {
    await auditLog("admin.backups.upload.denied", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: {
        reason: "owner_not_found",
        ownerId: payload.userId,
      },
    });
    return apiError(
      `Backup is for user '${payload.userId}' which does not exist in this DB`,
      422,
    );
  }

  // `MANUAL_UPLOAD_<unix-ms>` keeps the (userId, type) unique-constraint
  // intact so multiple uploads can coexist for the same user without
  // overwriting each other or the rolling WEEKLY_AUTO snapshot.
  const uploadType = `MANUAL_UPLOAD_${Date.now()}`;
  const encrypted = packBackupBlob(JSON.stringify(payload));

  const created = await prisma.dataBackup.create({
    data: {
      userId: owner.id,
      type: uploadType,
      data: encrypted,
    },
  });

  const summary = summarizeBackup(payload);

  await auditLog("admin.backups.upload", {
    userId: admin.id,
    ipAddress: getClientIp(request),
    details: {
      backupId: created.id,
      ownerId: owner.id,
      ownerUsername: owner.username,
      type: uploadType,
      schemaVersion: summary.schemaVersion,
      counts: {
        measurements: summary.measurements,
        medications: summary.medications,
        intakeEvents: summary.intakeEvents,
        moodEntries: summary.moodEntries,
        cycles: summary.cycles,
        cycleDayLogs: summary.cycleDayLogs,
        labResults: summary.labResults,
        biomarkers: summary.biomarkers,
        illnessEpisodes: summary.illnessEpisodes,
        illnessDayLogs: summary.illnessDayLogs,
        allergies: summary.allergies,
        familyHistory: summary.familyHistory,
        workouts: summary.workouts,
        documents: summary.documents,
      },
    },
  });

  const response: UploadResponse = {
    id: created.id,
    valid: true,
    summary,
  };
  return apiSuccess(response, 201);
});
