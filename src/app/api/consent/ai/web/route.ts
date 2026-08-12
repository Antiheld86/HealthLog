/**
 * v1.16.13 — web AI-consent grant.
 *
 *   POST /api/consent/ai/web
 *     Mints an `ai_full` consent receipt for the calling web user.
 *     Idempotent — a user with an active `ai_full` receipt is a no-op.
 *     The body decides what a missing receipt means:
 *
 *     no body (heal)            The AI-settings surface calls this on mount
 *                               (the web equivalent of the iOS shell-mount
 *                               heal) so an account that predates the consent
 *                               gate gains a receipt without a re-consent
 *                               step. A past revocation stands; the heal
 *                               never resurrects a withdrawn consent.
 *     `{ intent: "affirmative" }`  The explicit grant control on the same
 *                               surface. This IS the user's consent act, so
 *                               it may supersede an earlier revocation
 *                               exactly as the first grant would.
 *
 * Revocation stays on `DELETE /api/consent/ai/latest`; this route only
 * grants. The full CRUD (explicit grant with a signed artefact, reader,
 * revoke) lives in `../route.ts` + `../latest/route.ts`.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkConsentRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { ensureWebAiConsentReceipt } from "@/lib/consent/web-grant";
import type { WebConsentGrantIntent } from "@/lib/consent/web-grant";
import { webConsentGrantBody } from "@/lib/validations/consent";

export const POST = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  // The web AI-settings surface calls this on every mount; the bucket is
  // generous enough that the heal path is never throttled in normal use,
  // tight enough to cap a scripted loop.
  const rl = await checkConsentRateLimit(user.id);
  if (!rl.allowed) {
    annotate({
      action: { name: "consent.ai.rate-limited" },
      meta: { userId: user.id, resetAt: rl.resetAt },
    });
    return apiError("Too many consent requests, please wait a moment", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  // The mount heal posts no body; only the explicit grant control sends one.
  // Absence of a JSON body therefore reads as a heal, and a present body is
  // Zod-validated so a malformed intent is a 422, never a silent heal.
  let intent: WebConsentGrantIntent = "heal";
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const { data: body, error: jsonError } = await safeJson(req, {
      maxBytes: 1024,
    });
    if (jsonError) return jsonError;
    const parsed = webConsentGrantBody.safeParse(body);
    if (!parsed.success) {
      annotate({ action: { name: "consent.ai.web-grant.invalid_shape" } });
      return returnAllZodIssues(parsed.error, 422);
    }
    intent = parsed.data.intent;
  }

  const result = await ensureWebAiConsentReceipt(user.id, intent);

  if (result.minted) {
    // Audit trail parity with the iOS-driven POST /api/consent/ai grant so
    // the legal team can reconstruct web-originated consent; `intent`
    // separates a migration heal from the user's own re-grant click.
    // Fire-and-forget.
    auditLog("consent.ai.grant", {
      userId: user.id,
      details: {
        kind: "ai_full",
        source: "web",
        intent,
        receiptId: result.receipt.id,
      },
    }).catch(() => {});
  }

  annotate({
    action: { name: "consent.ai.web-grant" },
    meta: {
      minted: result.minted,
      intent,
      ...(result.minted ? { receiptId: result.receipt.id } : {}),
    },
  });

  return apiSuccess({
    minted: result.minted,
    kind: "ai_full" as const,
  });
});
