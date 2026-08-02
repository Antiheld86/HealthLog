/**
 * `POST /api/account/switch` — point this browser at a record, or back at its own.
 *
 * Cookie transport only. The Bearer carrier is a per-request header, and that
 * difference is not an inconsistency to be smoothed over: stamping a switch on
 * a long-lived token would make the credential itself ambient authority, and
 * the token has to keep meaning "this person" for as long as it exists. A
 * Bearer caller reaching this endpoint has misunderstood its own transport, so
 * it is refused rather than quietly ignored.
 *
 * An actor surface — `requireActorAuth()` — and it has to be, because this is
 * the way back. Under the fail-closed default every route refuses while a
 * switch is on; if this one did too, a switched browser could enter a record
 * and never leave it, which turns a read-only convenience into a trap. So the
 * mode is declared, and the declaration is narrow: the only row this handler
 * touches is the caller's own session.
 *
 * What it writes is a SELECTOR, not a permission. The grant is validated here
 * before the stamp so a client gets an immediate, honest refusal instead of a
 * switch that appears to work and 403s on the next page — but the stamp itself
 * authorises nothing, and the resolver re-checks the grant on every request
 * that follows. A value stranded here by a revocation seconds later confers
 * exactly nothing.
 */
import { NextRequest } from "next/server";

import {
  apiHandler,
  requireActorAuth,
  SharingAccessDeniedError,
} from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { pointSessionAt } from "@/lib/sharing/acting-session";
import { findActiveGrant } from "@/lib/sharing/grants";
import { switchAccountSchema } from "@/lib/validations/account-sharing";

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireActorAuth();

  if (auth.authMethod !== "cookie") {
    return apiError(
      "Account switching is a browser-session feature; send the account selector header instead",
      400,
      { errorCode: "sharing.switch.wrong_transport" },
    );
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 4 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = switchAccountSchema.safeParse(rawBody);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "sharing.switch.invalid",
    });
  }

  const { accountId } = parsed.data;
  const ip = getClientIp(request);

  if (accountId === null) {
    await pointSessionAt(auth.session.id, auth.user.id, null);
    await auditLog("sharing.switch.off", {
      userId: auth.user.id,
      details: {},
      ipAddress: ip,
    }).catch(() => {});
    annotate({ action: { name: "sharing.switch.off" } });
    return apiSuccess({ actingAs: null });
  }

  // The same predicate the resolver uses, on the same table, with no second
  // idea of "active" anywhere in this file. If this route decided for itself,
  // it would drift from the resolver in exactly one direction: a switch the
  // panel accepts and the next request refuses, or worse, the reverse.
  const grant = await findActiveGrant({
    grantorId: accountId,
    granteeId: auth.user.id,
  });
  if (!grant) {
    // The flat refusal, with no reason on the wire. An account that does not
    // exist and an account that granted nothing are the same empty row from
    // the same query, so a caller learns nothing about who has an account here.
    await auditLog("sharing.access.denied", {
      userId: auth.user.id,
      details: { reason: "switch_no_active_grant", target: accountId },
      ipAddress: ip,
    }).catch(() => {});
    throw new SharingAccessDeniedError();
  }

  const owner = await prisma.user.findUniqueOrThrow({
    where: { id: grant.grantorId },
    select: { id: true, username: true, displayName: true },
  });

  await pointSessionAt(auth.session.id, auth.user.id, owner.id);

  await auditLog("sharing.switch.on", {
    userId: auth.user.id,
    details: { grantId: grant.id, grantorId: owner.id },
    ipAddress: ip,
  }).catch(() => {});

  annotate({
    action: { name: "sharing.switch.on" },
    meta: { grant_id: grant.id },
  });

  return apiSuccess({
    actingAs: {
      accountId: owner.id,
      username: owner.username,
      displayName: owner.displayName,
      access: grant.access,
    },
  });
});
