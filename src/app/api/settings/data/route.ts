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
import { invalidateUserData } from "@/lib/cache/invalidate";
import {
  LastManagedGuardianError,
  protectManagedProfilesDuringDataWipe,
} from "@/lib/managed-profiles/lifecycle";
import {
  resolveWipeDelegate,
  USER_RESET,
  wipeDelegateKey,
  WIPE_MODELS,
} from "@/lib/data-wipe/wipe-plan";

export const dynamic = "force-dynamic";

/**
 * Budget for the wipe transaction.
 *
 * Prisma's default interactive-transaction timeout is 5 s, which was already
 * optimistic for thirteen `deleteMany` statements and is not survivable for
 * the full user-scoped set on an account with a large import behind it. The
 * whole action is one transaction on purpose — a half-applied wipe is worse
 * than none, because the person is told it succeeded either way.
 */
const WIPE_TRANSACTION_TIMEOUT_MS = 120_000;
const WIPE_TRANSACTION_MAX_WAIT_MS = 15_000;

/**
 * Delete every row this account owns, keeping the account and the credentials
 * that sign into it.
 *
 * The set of tables is not written here. It is declared once in
 * `@/lib/data-wipe/wipe-plan` and held against `prisma/schema.prisma` by
 * `src/__tests__/data-wipe-completeness.test.ts`, so a model added to the
 * schema cannot quietly land outside the wipe — which is exactly how this
 * route came to delete thirteen tables out of eighty-odd while telling people
 * it had deleted all of them.
 *
 * v1.23 — gated by a fresh step-up for MFA-enrolled accounts (see the account
 * deletion route); single-factor accounts keep the typed-confirmation-only
 * contract. Over Bearer the step-up is a fresh-factor elevation in the
 * `X-Step-Up` header, spent right before the transaction — the same arm the
 * account deletion route carries, for the same App Store reason.
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

  if (confirm !== "DELETE") {
    return apiError("Confirmation missing", 422);
  }

  const userId = user.id;

  // The confirmation has passed; spend the Bearer elevation before the wipe
  // (a no-op on the cookie path).
  await auth.commitElevation();

  let counts: Record<string, number>;
  try {
    counts = await prisma.$transaction(
      async (tx) => {
        // This precedes every data delete and holds the managed-record locks
        // through AccountGrant removal. A queued Guardian egress claim thus
        // rechecks after this wipe commits instead of sending from a grant
        // this transaction has already deleted.
        await protectManagedProfilesDuringDataWipe(tx, userId);

        const perModel: Record<string, number> = {};
        for (const model of WIPE_MODELS) {
          const { count } = await resolveWipeDelegate(tx, model).deleteMany({
            where: { userId },
          });
          if (count > 0) perModel[wipeDelegateKey(model)] = count;
        }

        // The account row survives; the personal data carried on its own columns
        // does not. Same classification contract as the model list.
        await tx.user.update({ where: { id: userId }, data: USER_RESET });

        return perModel;
      },
      {
        timeout: WIPE_TRANSACTION_TIMEOUT_MS,
        maxWait: WIPE_TRANSACTION_MAX_WAIT_MS,
      },
    );
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

  const deletedRows = Object.values(counts).reduce((sum, n) => sum + n, 0);

  // Written after the transaction commits, so the row cannot be removed by the
  // AuditLog delete inside it. The person's whole audit history goes; this one
  // row stays as the receipt for the erasure they asked for. Account deletion
  // takes the other branch and purges even this, because there is no longer an
  // account for it to belong to.
  await auditLog("user.data.clear", {
    userId,
    ipAddress: getClientIp(request),
    details: { deletedRows, models: counts },
  });

  annotate({
    action: { name: "settings.data.clear" },
    meta: {
      deleted_rows: deletedRows,
      models_wiped: WIPE_MODELS.length,
      models_with_rows: Object.keys(counts).length,
    },
  });

  // v1.16.9 — every cached payload was built on the rows just deleted;
  // hard-evict the user's buckets so no surface serves pre-wipe data.
  invalidateUserData(userId);

  return apiSuccess({ cleared: true, deletedRows, models: counts });
});
