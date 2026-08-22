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
import { apiHandler, requireAuth } from "@/lib/api-handler";
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

export const DELETE = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { user } = await requireAuth();

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
