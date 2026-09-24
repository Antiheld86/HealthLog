/**
 * v1.4.40 SB-10 — AI consent latest-receipt reader + revoke endpoint.
 *
 *   GET /api/consent/ai/latest?kind=ai_full
 *     Returns the latest non-revoked receipt for that kind, or null.
 *
 *   GET /api/consent/ai/latest
 *     Returns the latest non-revoked receipt per kind, keyed by kind.
 *
 *   DELETE /api/consent/ai/latest?kind=ai_full
 *     Marks the latest active receipt for that kind as revoked.
 *
 *   DELETE /api/consent/ai/latest
 *     Master toggle — revokes the latest active receipt across every
 *     consent kind. Returns the list of revoked rows.
 *
 * Either DELETE also deletes the regenerable model-written text (status
 * notes, the cached briefing, model-written narratives, reaction lines,
 * workout paragraphs) when it leaves no receipt covering the analysis, in the
 * same transaction as the revoke. Coach memory and document summaries stay.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkConsentRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  consentKindEnum,
  consentLatestQuery,
  type ConsentKind,
} from "@/lib/validations/consent";
import {
  latestActiveReceipt,
  latestActiveReceiptsByKind,
} from "@/lib/consent/receipts";
import { withdrawConsent } from "@/lib/consent/withdrawal";
import { serialiseReceipt } from "../route";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

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

  const parsed = consentLatestQuery.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 400 (consent routes use 400 not 422).
    return returnAllZodIssues(parsed.error, 400);
  }

  const { kind } = parsed.data;

  if (kind) {
    const receipt = await latestActiveReceipt(user.id, kind);
    annotate({
      action: { name: "consent.ai.latest" },
      meta: { kind, found: receipt != null },
    });
    return apiSuccess({
      kind,
      receipt: receipt ? serialiseReceipt(receipt) : null,
    });
  }

  const byKind = await latestActiveReceiptsByKind(user.id);
  // Map each enum value to either the serialised row or `null` so the
  // client always sees the full keyspace and never has to guess
  // whether a missing key means "not granted" or "schema gap".
  const result: Record<
    ConsentKind,
    ReturnType<typeof serialiseReceipt> | null
  > = {
    ai_full: byKind.ai_full ? serialiseReceipt(byKind.ai_full) : null,
    ai_insights_only: byKind.ai_insights_only
      ? serialiseReceipt(byKind.ai_insights_only)
      : null,
    ai_coach: byKind.ai_coach ? serialiseReceipt(byKind.ai_coach) : null,
    ai_extraction: byKind.ai_extraction
      ? serialiseReceipt(byKind.ai_extraction)
      : null,
  };

  annotate({
    action: { name: "consent.ai.latest" },
    meta: {
      kinds_active: Object.entries(result)
        .filter(([, v]) => v != null)
        .map(([k]) => k),
    },
  });

  return apiSuccess(result);
});

export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

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

  const parsed = consentLatestQuery.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 400 (consent routes use 400 not 422).
    return returnAllZodIssues(parsed.error, 400);
  }

  const { kind } = parsed.data;

  // One kind, or every kind for the master "turn AI off" toggle. The revoke
  // and the purge of the regenerable text the consent covered commit
  // together (`withdrawConsent`).
  const kinds = kind ? [kind] : consentKindEnum.options;
  const { revoked, purged } = await withdrawConsent(user.id, kinds);

  for (const { kind: k, receipt } of revoked) {
    auditLog("consent.ai.revoke", {
      userId: user.id,
      details: { kind: k, receiptId: receipt.id },
    }).catch(() => {});
  }
  if (purged) {
    // Counts only, never content.
    auditLog("consent.ai.purge", {
      userId: user.id,
      details: { ...purged },
    }).catch(() => {});
  }

  annotate({
    action: { name: "consent.ai.revoke" },
    meta: {
      kinds_revoked: revoked.map((r) => r.kind),
      count: revoked.length,
      purged: purged !== null,
    },
  });

  if (kind) {
    // Idempotent: "no active receipt to revoke" is success-shaped. The iOS
    // toggle hammers this on every flip; returning 404 would surface as a
    // spurious error in the client.
    const receipt = revoked[0]?.receipt ?? null;
    return apiSuccess({
      kind,
      receipt: receipt ? serialiseReceipt(receipt) : null,
    });
  }

  return apiSuccess({
    revoked: revoked.map((r) => ({
      kind: r.kind,
      receipt: serialiseReceipt(r.receipt),
    })),
  });
});
