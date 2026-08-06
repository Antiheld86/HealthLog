import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";
import {
  apiHandler,
  requireFreshMfaIfEnrolled,
  MFA_STEP_UP_MAX_AGE_SECONDS,
} from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  deleteGuardianAccountWithLifecycle,
  LastManagedGuardianError,
} from "@/lib/managed-profiles/lifecycle";

export const dynamic = "force-dynamic";

/**
 * Permanently delete the user account and ALL associated data.
 * Cascading deletes in the schema handle all related records.
 *
 * v1.23 — for an account with a second factor active this requires a fresh
 * step-up (within MFA_STEP_UP_MAX_AGE_SECONDS) in addition to the typed
 * confirmation, so a hijacked live session cannot erase the record. Accounts
 * without MFA are unaffected and keep the typed-confirmation-only contract.
 */
export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireFreshMfaIfEnrolled(MFA_STEP_UP_MAX_AGE_SECONDS);

  let confirm = "";
  try {
    const raw = await request.text();
    if (raw.length > 64 * 1024) {
      return apiError(`Request body exceeds ${64 * 1024} bytes`, 413);
    }
    const body = JSON.parse(raw);
    confirm = typeof body?.confirm === "string" ? body.confirm : "";
  } catch {
    return apiError("Invalid request", 422);
  }

  if (confirm !== "DELETE_ACCOUNT") {
    return apiError(
      "Confirmation missing. Send { confirm: 'DELETE_ACCOUNT' }",
      422,
    );
  }

  // Prevent last admin from deleting themselves
  if (user.role === "ADMIN") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      return apiError("The last admin account cannot be deleted", 400);
    }
  }

  const userId = user.id;
  const username = user.username;

  // Log BEFORE deletion. The audit row's userId is SetNull post-cascade
  // (per schema), but we then immediately purge it below for GDPR Art. 17
  // erasure completeness — see comment further down.
  await auditLog("user.account.delete", {
    userId,
    ipAddress: getClientIp(request),
    details: { username },
  });

  try {
    await deleteGuardianAccountWithLifecycle(userId, async (tx) => {
      // Destroy all sessions before the user row goes, inside the same record
      // lifecycle transaction so a refusal leaves every account state intact.
      await tx.session.deleteMany({ where: { userId } });

      // Audit V3 NEW-V3-2 / GDPR Art. 17 fix: AuditLog rows have
      // `onDelete: SetNull` in the schema, which keeps PII (IP addresses, login
      // city geo) attached to the record after the user is deleted. We explicitly
      // purge them inside the same logical operation so account deletion is
      // genuinely complete erasure.
      await tx.auditLog.deleteMany({ where: { userId } });

      // Delete user — all other related data is removed via onDelete: Cascade.
      await tx.user.delete({ where: { id: userId } });
    });
  } catch (error) {
    if (error instanceof LastManagedGuardianError) {
      return apiError(
        "Add another Guardian or delete the managed profile first",
        409,
        { errorCode: "managed_profile.guardian.required" },
      );
    }
    throw error;
  }

  annotate({
    action: { name: "settings.account.delete" },
    meta: { username },
  });

  return apiSuccess({ deleted: true });
});
