/**
 * Per-user "read documents automatically with AI" opt-in endpoint.
 *
 *  GET    /api/auth/me/documents-auto-ai-read  — current flag.
 *  PATCH  /api/auth/me/documents-auto-ai-read  — body `{ documentsAutoAiRead: boolean }`.
 *
 * OFF by default: the document vault stays local-first and every external AI
 * egress needs an explicit per-document action + an active consent receipt. When
 * `true`, the auto-index-on-upload job may read a freshly uploaded document
 * through the user's configured external provider with no per-document tap.
 *
 * Flipping it ON is itself the standing consent act, so the write also mints an
 * append-only `ai_full` consent receipt (`ensureWebAiConsentReceipt`) — the
 * durable audit record that sits alongside the runtime short-circuit the
 * document consent gate reads. An OFF→ON flip additionally schedules a bounded
 * catch-up over the documents already stored (`enqueueSummaryCatchUp`), because
 * the summary job is enqueued at upload time and would otherwise never revisit
 * a vault filled before the opt-in. Mirrors `auth/me/labs-local-ocr`: 60/min rate
 * limit, Zod `safeParse` → 422 via `returnAllZodIssues`, audit-log row,
 * field-by-field write (no mass assignment). Idempotent — always returns the
 * resolved next state so the client can hard-set the optimistic update.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { ensureWebAiConsentReceipt } from "@/lib/consent/web-grant";
import { prisma } from "@/lib/db";
import { enqueueSummaryCatchUp } from "@/lib/jobs/document-summary-catchup";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { documentsAutoAiReadPatchSchema } from "@/lib/validations/user-prefs";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

type DocumentsAutoAiReadResponse = {
  documentsAutoAiRead: boolean;
};

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.documentsAutoAiRead.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { documentsAutoAiRead: true },
  });
  const payload: DocumentsAutoAiReadResponse = {
    documentsAutoAiRead: row?.documentsAutoAiRead ?? false,
  };
  return apiSuccess(payload);
});

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `documents-auto-ai-read:patch:${user.id}`,
    PATCH_RATE_LIMIT,
    PATCH_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  // The body is a single boolean — bound the parse so a malformed or oversized
  // payload is rejected before it is materialised.
  const { data: body, error: jsonError } = await safeJson(req, {
    maxBytes: 1024,
  });
  if (jsonError) return jsonError;

  const parsed = documentsAutoAiReadPatchSchema.safeParse(body);
  if (!parsed.success) {
    annotate({
      action: { name: "auth.me.documentsAutoAiRead.patch.invalid_shape" },
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const next = parsed.data.documentsAutoAiRead;

  const previous = await prisma.user.findUnique({
    where: { id: user.id },
    select: { documentsAutoAiRead: true },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { documentsAutoAiRead: next },
  });

  // Turning the toggle ON is the standing consent act — mint an append-only
  // `ai_full` receipt (idempotent) so the durable audit trail records it, in
  // addition to the runtime short-circuit the document consent gate reads.
  if (next) {
    await ensureWebAiConsentReceipt(user.id, "affirmative");
  }

  // A genuine OFF→ON flip schedules a catch-up over the documents already in
  // the vault. Without it the switch only ever applied to FUTURE uploads: the
  // summary job is enqueued at upload time and no-ops while the flag is OFF, so
  // a user who uploaded first and opted in later saw the toggle do nothing.
  // Fire-and-forget and bounded; the pass only enqueues, and every consent and
  // budget gate still runs per document inside the summary job itself.
  const wasEnabled = previous?.documentsAutoAiRead ?? false;
  if (next && !wasEnabled) {
    void enqueueSummaryCatchUp(user.id);
  }

  await auditLog("user.documentsAutoAiRead.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      previous: previous?.documentsAutoAiRead ?? false,
      next,
    },
  });

  annotate({
    action: { name: "auth.me.documentsAutoAiRead.patch" },
    meta: { documentsAutoAiRead: next },
  });

  const payload: DocumentsAutoAiReadResponse = { documentsAutoAiRead: next };
  return apiSuccess(payload);
});
