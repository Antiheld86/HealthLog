/**
 * v1.18.9 — GET /api/labs/ocr/capability
 *
 * Cheap probe (no provider call) the Labs UI uses to decide whether to show
 * the "Scan a report" affordance. Returns `{ available, reason, pdfSupported }`
 * for the calling user's configured AI provider. The surface stays dark for
 * users with no provider configured and no local-OCR opt-in, and whenever the
 * `labsOcr` capability is closed (operator switch, labs module, sharing grant);
 * `ai` says which.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { resolveOcrCapability } from "@/lib/labs/ocr-capability";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const capability = await resolveOcrCapability(user.id);

  annotate({
    action: { name: "labs.ocr.capability" },
    meta: {
      available: capability.available,
      mode: capability.mode,
      reason: capability.reason,
      pdfSupported: capability.pdfSupported,
      aiReason: capability.ai.reason,
    },
  });

  return apiSuccess(capability);
});
