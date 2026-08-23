import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { NextRequest } from "next/server";
import {
  apiHandler,
  requireAuth,
  requireMfaManagementAuth,
} from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { passkeyRenameSchema } from "@/lib/validations/auth";

export const PATCH = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 4 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = passkeyRenameSchema.safeParse(body);
    if (!parsed.success) {
      // Multi-issue, like every sibling that parses a body. The flat
      // `apiError("Invalid request", 422)` this replaces discarded the issues,
      // so a person renaming a passkey could not tell an empty name from one
      // over the 64-character limit — the form had nothing to put beside the
      // field.
      return returnAllZodIssues(parsed.error, 422);
    }

    const passkey = await prisma.passkey.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!passkey || passkey.userId !== user.id) {
      return apiError("Passkey not found", 404);
    }

    const updated = await prisma.passkey.update({
      where: { id },
      data: { name: parsed.data.name },
      select: {
        id: true,
        name: true,
        credentialDeviceType: true,
        credentialBackedUp: true,
        createdAt: true,
        lastUsedAt: true,
      },
    });

    annotate({ action: { name: "auth.passkey.rename" } });
    return apiSuccess(updated);
  },
);

/**
 * Remove a passkey — step-up gated, on the same mechanism the second-factor
 * security-key removal uses.
 *
 * The two deletions were not equals. Removing a registered SECOND factor
 * demanded a fresh factor proof; removing a passkey, which is the PRIMARY
 * sign-in credential, took a plain cookie session or a wildcard Bearer. The
 * last-method check below stops an account locking itself out, but it does
 * nothing about a hijacked session quietly stripping the credentials the owner
 * signs in with. So this route goes through `requireMfaManagementAuth` too.
 *
 * Two consequences worth stating rather than discovering:
 *
 *   BEARER IS NOT REFUSED. `requireFreshMfa` is cookie-only, so a gate built on
 *   it alone would have told the native client to go and use the website. The
 *   gate this route borrows has a Bearer arm — a step-up elevation minted
 *   against a re-proved factor, exactly what the app already does to remove a
 *   security key — so the app keeps the capability and pays the same price the
 *   web pays.
 *
 *   AN ACCOUNT WITH NO SECOND FACTOR IS NOT LOCKED OUT. `freshFactor: true`
 *   refuses those outright, which is right for a route that manages a second
 *   factor and wrong here: most accounts with a passkey have nothing else
 *   enrolled, and they would lose the ability to remove their own credential.
 *   `"if-enrolled"` gates the accounts that can clear the gate and leaves the
 *   rest exactly where they were.
 */
export const DELETE = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const auth = await requireMfaManagementAuth({ freshFactor: "if-enrolled" });
    const { user } = auth;

    const { id } = await params;

    const passkey = await prisma.passkey.findUnique({
      where: { id },
    });

    if (!passkey || passkey.userId !== user.id) {
      return apiError("Passkey not found", 404);
    }

    // Check: at least 1 auth method must remain
    const passkeyCount = await prisma.passkey.count({
      where: { userId: user.id },
    });
    const hasPassword = !!user.passwordHash;

    if (passkeyCount <= 1 && !hasPassword) {
      return apiError(
        "Cannot delete — at least one authentication method must remain",
        400,
      );
    }

    // Ownership resolved and the last-method check passed — spend the elevation
    // now, so a 404 for someone else's id or a refused last credential does not
    // burn a proof the caller then has to mint again. Same ordering as the
    // security-key removal.
    await auth.commitElevation();

    await prisma.passkey.delete({ where: { id } });

    await auditLog("auth.passkey.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { passkeyId: id, passkeyName: passkey.name },
    });

    annotate({ action: { name: "auth.passkey.delete" } });

    return apiSuccess({ success: true });
  },
);
