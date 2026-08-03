/**
 * POST /api/export/encrypted
 *
 * v1.23 — passphrase-encrypted variant of the full-backup export. Returns the
 * same payload as `GET /api/export/full-backup` (see that route's doc comment
 * for which domains restore recreates vs. export-only), sealed into an
 * `HLX1` archive (Argon2id-derived key + AES-256-GCM) under a passphrase the
 * caller supplies in the request body. The binary archive is returned as
 * `application/octet-stream`.
 *
 * SECURITY:
 *  - Step-up: when the account has any second factor enrolled (TOTP OR a
 *    security key), this is gated by `requireFreshMfaIfEnrolled` — exporting the
 *    whole record is a sensitive action. Single-factor accounts fall back to a
 *    normal authenticated session.
 *  - The passphrase NEVER hits a log or wide-event: it is read off the parsed
 *    body, passed straight into the KDF, and never `annotate()`d. The egress
 *    redaction denylist already scrubs `/passphrase/i` (key-name) and the
 *    `passphrase=` query-string form as defence in depth.
 *  - There is NO server-side recovery — the passphrase is not stored. A
 *    forgotten passphrase means the archive is unrecoverable; the UI says so.
 *
 * Auth: cookie session OR Bearer for single-factor accounts; cookie + fresh
 * second factor for MFA accounts (Bearer can never satisfy step-up).
 * Rate-limit: shared `export:<userId>` bucket (10/h) — same bucket as the
 * plaintext export so the encrypted variant cannot be used to bypass the cap.
 * Audit: `user.export.encrypted` with the row counts (never the passphrase).
 */
import { prisma } from "@/lib/db";
import { z } from "zod/v4";
import {
  apiHandler,
  requireFreshMfaIfEnrolled,
  MFA_STEP_UP_MAX_AGE_SECONDS,
} from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import {
  encryptArchive,
  MIN_EXPORT_PASSPHRASE_LENGTH,
} from "@/lib/export/passphrase-archive";
import { NextRequest, NextResponse } from "next/server";

const encryptedExportSchema = z
  .object({
    passphrase: z
      .string()
      .min(MIN_EXPORT_PASSPHRASE_LENGTH)
      // A generous upper bound — a passphrase, not a file. Keeps the KDF input
      // bounded.
      .max(1024),
  })
  .strict();

export const POST = apiHandler(async (request: NextRequest) => {
  // Resolve the session (cookie or Bearer), then escalate to a fresh second
  // factor when the account has one enrolled. `requireFreshMfaIfEnrolled`
  // covers BOTH cohorts — a confirmed TOTP secret AND a registered WebAuthn
  // security key — so a security-key-only account is gated too. A single-factor
  // account cannot produce a fresh-MFA proof, so it passes straight through
  // rather than being locked out of its own encrypted export.
  const auth = await requireFreshMfaIfEnrolled(MFA_STEP_UP_MAX_AGE_SECONDS);
  const user = auth.user;
  annotate({ action: { name: "user.export.encrypted" } });

  const rl = await checkRateLimit(`export:${user.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 exports per hour", 429);
  }

  // The body is a single passphrase string — small and bounded. 8 KB is far
  // above any legitimate passphrase while rejecting a large body before parse.
  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 8 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = encryptedExportSchema.safeParse(body);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error);
  }
  const { passphrase } = parsed.data;

  const { payload, counts } = await buildFullBackupPayload(prisma, user.id);

  // Encrypt the JSON bytes. The passphrase goes no further than the KDF.
  const archive = await encryptArchive(JSON.stringify(payload), passphrase);

  await auditLog("user.export.encrypted", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { counts, format: "HLX1" },
  });

  annotate({
    meta: {
      export_measurements_count: counts.measurements,
      export_medications_count: counts.medications,
      export_intake_count: counts.intakeEvents,
      export_medication_side_effect_count: counts.medicationSideEffects,
      export_mood_count: counts.moodEntries,
      export_cycle_count: counts.cycles,
      export_cycle_day_log_count: counts.cycleDayLogs,
      export_lab_result_count: counts.labResults,
      export_biomarker_count: counts.biomarkers,
      export_illness_episode_count: counts.illnessEpisodes,
      export_illness_day_log_count: counts.illnessDayLogs,
      export_allergy_count: counts.allergies,
      export_family_history_count: counts.familyHistory,
      export_workout_count: counts.workouts,
      export_document_count: counts.documents,
      export_nutrient_day_count: counts.nutrientDays,
      export_health_profile_count: counts.healthProfile,
      export_custom_metric_count: counts.customMetrics,
      export_custom_metric_entry_count: counts.customMetricEntries,
      export_intraday_profile_count: counts.intradayProfiles,
      export_archive_bytes: archive.byteLength,
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  // Return the raw binary archive (NOT the apiSuccess envelope). The file is a
  // self-contained `.hlx` archive openable with the user's passphrase via
  // scripts/decrypt-export.ts.
  return new NextResponse(new Uint8Array(archive), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="healthlog-backup-${user.id}-${stamp}.hlx"`,
      "Cache-Control": "no-store",
    },
  });
});
