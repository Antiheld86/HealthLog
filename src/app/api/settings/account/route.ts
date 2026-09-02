import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";
import {
  apiHandler,
  requireFreshMfaOrElevationIfEnrolled,
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
 *
 * Over Bearer the fresh step-up is a single-use elevation from
 * `POST /api/auth/step-up` in the `X-Step-Up` header, minted against a TOTP,
 * security-key, or passkey proof — a password proof is refused. App Store
 * guideline 5.1.1(v) requires in-app deletion, and until this arm existed an
 * MFA-enrolled account could not delete itself from the native app at all.
 * The elevation is spent immediately before the erasure, after every cheap
 * refusal, so a bad confirmation does not burn it.
 */
export const DELETE = apiHandler(async (request: NextRequest) => {
  const auth = await requireFreshMfaOrElevationIfEnrolled(
    MFA_STEP_UP_MAX_AGE_SECONDS,
  );
  const { user } = auth;

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

  // Every refusal that costs nothing has passed; spend the Bearer elevation
  // now (a no-op on the cookie path). A lost claim throws the same 401 as a
  // missing one, so a concurrent redemption still has exactly one winner.
  //
  // One refusal can still land after this: the last-Guardian 409, which is
  // decided under the record lock inside the lifecycle transaction and has no
  // cheap pre-check. That caller spends a proof on a refusal and has to mint
  // another. Moving the spend past the transaction would be the worse trade —
  // the elevation would stay redeemable while the erasure was already running.
  await auth.commitElevation();

  try {
    await deleteGuardianAccountWithLifecycle(userId, async (tx) => {
      // The invariant has now passed, so this success event cannot survive a
      // refusal. It is purged with the rest of the account's audit history.
      await auditLog("user.account.delete", {
        userId,
        ipAddress: getClientIp(request),
        details: { username },
        client: tx,
      });

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
