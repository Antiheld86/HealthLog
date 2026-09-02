import { NextRequest } from "next/server";
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(`codex-disconnect:${user.id}`, 5, 60_000);
  if (!rl.allowed) throw new HttpError(429, "Too many requests");

  await prisma.user.update({
    where: { id: user.id },
    data: {
      codexAccessTokenEncrypted: null,
      codexRefreshTokenEncrypted: null,
      codexTokenExpiresAt: null,
      codexConnectedAt: null,
      codexConnectionStatus: "disconnected",
      insightsCachedAt: null,
      insightsCachedText: null,
      insightsCachedLocale: null,
    },
  });

  await auditLog("codex.oauth.disconnected", {
    userId: user.id,
    ipAddress: getClientIp(request),
  });
  annotate({ action: { name: "codex.oauth.disconnect" } });

  return apiSuccess({ disconnected: true });
});
