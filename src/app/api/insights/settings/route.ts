import { prisma } from "@/lib/db";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { isCodexOAuthConfigured } from "@/lib/ai/codex-oauth";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      codexConnectionStatus: true,
      codexConnectedAt: true,
      useCentralCodex: true,
      insightsPrivacyMode: true,
      insightsCachedAt: true,
    },
  });

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      adminAiKeyEncrypted: true,
      adminCodexConnectionStatus: true,
      adminCodexAccessTokenEncrypted: true,
      adminCodexRefreshTokenEncrypted: true,
      adminCodexAccountIdEncrypted: true,
    },
  });

  // Presence-only: whether the operator has connected the shared central Codex.
  // The encrypted tokens themselves are NEVER returned to a non-admin client —
  // only this boolean and the user's own opt-in flag leave the server.
  const centralCodexAvailable =
    settings?.adminCodexConnectionStatus === "connected" &&
    !!settings.adminCodexAccessTokenEncrypted &&
    !!settings.adminCodexRefreshTokenEncrypted &&
    !!settings.adminCodexAccountIdEncrypted;

  annotate({ action: { name: "insights.settings.get" } });

  return apiSuccess({
    codexStatus: dbUser?.codexConnectionStatus ?? "disconnected",
    codexConnectedAt: dbUser?.codexConnectedAt ?? null,
    hasAdminKey: !!settings?.adminAiKeyEncrypted,
    // v1.4.3: surface whether the operator has a `CODEX_OAUTH_CLIENT_ID`
    // configured. Without it the Connect-with-ChatGPT flow is dead, so
    // the UI hides the button instead of redirecting to a chatgpt.com
    // login the user can never complete.
    codexOauthConfigured: isCodexOAuthConfigured(),
    // Operator-shared central Codex — only surfaced so the per-user opt-in
    // switch shows when the operator connected it. OFF everywhere by default.
    centralCodexAvailable,
    useCentralCodex: dbUser?.useCentralCodex ?? false,
    privacyMode: dbUser?.insightsPrivacyMode ?? "aggregated",
    lastInsightAt: dbUser?.insightsCachedAt ?? null,
  });
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson<
    Record<string, unknown>
  >(request, { maxBytes: 64 * 1024 });
  if (jsonError) return jsonError;

  const data: Record<string, unknown> = {};

  if (typeof body.privacyMode === "string") {
    const mode = body.privacyMode as string;
    if (!["aggregated", "raw"].includes(mode)) {
      return apiError("Invalid privacy mode", 422);
    }
    data.insightsPrivacyMode = mode;
    data.insightsCachedAt = null;
    data.insightsCachedText = null;
    data.insightsCachedLocale = null;
  }

  if (Object.keys(data).length === 0) {
    return apiError("No changes", 422);
  }

  await prisma.user.update({
    where: { id: user.id },
    data,
  });

  annotate({ action: { name: "insights.settings.update" } });

  return apiSuccess({ updated: true });
});
