/**
 * v1.16.13 — web AI-consent receipt minting.
 *
 * The `ConsentReceipt` gate (`src/lib/ai/consent-guard.ts`, shipped in
 * commit 37e9f32f) requires an active receipt before any health snapshot
 * egresses via the operator's server-managed OpenAI key (`admin-openai`).
 * iOS mints an `ai_full` receipt on consent grant + once per shell mount
 * to heal existing accounts. The web client never minted one, so web users
 * on a shared-key deployment saw the fail-closed no-key fallback on every
 * AI surface.
 *
 * This helper closes that gap: it mints an `ai_full` receipt for the web
 * user when none is active, mirroring the iOS master-grant pattern. It is
 * idempotent — a user with an active `ai_full` receipt is a no-op, so it is
 * safe to call on every AI-settings mount (the web equivalent of the iOS
 * shell-mount heal). Explicit revocation flows through the existing
 * `DELETE /api/consent/ai/latest`; this helper only ever grants.
 *
 * It heals an account that never gave consent — never one that took it
 * back. "No active receipt" has two very different causes: an account that
 * predates the gate and has no receipt at all, and an account whose owner
 * deliberately revoked. Both look identical to a `revokedAt: null` lookup,
 * and healing the second one re-grants a consent the user withdrew, writing
 * a `consent.ai.grant` audit row for an action they never took. GDPR Art. 7
 * (3) requires withdrawal to be as easy as granting; a withdrawal undone by
 * the next page visit is not a withdrawal. So the mint is gated on the
 * account having no revoked `ai_full` receipt in its history: a prior
 * revocation is a standing decision, and only an explicit grant may lift it.
 *
 * The artefact is a small JSON record of the web grant context (no signed
 * PDF/JWT — the web grant is an in-app affirmative action recorded with its
 * timestamp + source, which is the GDPR Art. 7 audit signal the legal team
 * needs). It stays well under the 64 KB artefact cap.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { isP2002 } from "@/lib/prisma-errors";
import { latestActiveReceipt } from "@/lib/consent/receipts";
import type { ConsentReceipt } from "@/lib/consent/receipts";

/**
 * Outcome of an idempotent web-grant call. `minted: false` carries a reason
 * so callers can tell "already granted" apart from "withheld because the
 * user revoked" — the two are the same non-event to the UI, but only the
 * second one is worth an audit annotation.
 */
export type WebConsentGrantResult =
  | { minted: true; receipt: ConsentReceipt }
  | { minted: false; reason: "already_active" | "previously_revoked" };

/**
 * How the call came about. The distinction decides whether a past revocation
 * blocks the mint, so it is a required argument rather than a default —
 * a caller must say which one it is.
 *
 *   `heal`       — fired by the AI-settings mount, not by a user gesture.
 *                  Grants only to an account that has no consent history at
 *                  all. A revocation stands.
 *   `affirmative`— the user just performed the opt-in itself (switching the
 *                  document auto-read on). This IS the consent act, so it
 *                  supersedes an earlier revocation, exactly as the first
 *                  grant would.
 */
export type WebConsentGrantIntent = "heal" | "affirmative";

/**
 * Ensure the web user has an active `ai_full` consent receipt, minting one
 * if absent. Idempotent: returns `{ minted: false }` when an active master
 * grant already exists, so callers can invoke it freely on mount.
 *
 * Mirrors the iOS `ai_full` grant. `ai_full` is the master kind that
 * satisfies every surface gate (insights + coach), matching the iOS app's
 * single master toggle rather than per-surface web grants.
 */
export async function ensureWebAiConsentReceipt(
  userId: string,
  intent: WebConsentGrantIntent,
  now: Date = new Date(),
): Promise<WebConsentGrantResult> {
  // Fast path: a cheap read outside the transaction short-circuits the
  // common already-granted case (every mount after the first) without
  // opening a transaction.
  const existing = await latestActiveReceipt(userId, "ai_full");
  if (existing) return { minted: false, reason: "already_active" };

  // A revoked receipt anywhere in this account's history means the user made
  // a decision. Healing past it would re-grant what they withdrew. An
  // affirmative act is the user deciding again, so it may proceed.
  if (intent === "heal") {
    const revoked = await prisma.consentReceipt.findFirst({
      where: { userId, kind: "ai_full", revokedAt: { not: null } },
      select: { id: true },
    });
    if (revoked) return { minted: false, reason: "previously_revoked" };
  }

  const artefact = JSON.stringify({
    source: "web",
    kind: "ai_full",
    grantedAt: now.toISOString(),
    note: "In-app affirmative AI consent granted via the web client.",
  });

  // Two web mounts can pass the fast-path read concurrently and both reach
  // the mint. The transaction re-checks under a Serializable isolation so a
  // second mint sees the first's row and no-ops; the partial unique index
  // (migration 0159, `WHERE revoked_at IS NULL`) is the structural backstop
  // if the re-check still races. A unique violation from the backstop means
  // a concurrent grant already won — that is success-shaped (the user ends
  // up with exactly one active receipt), so we map it to `{ minted: false }`.
  try {
    return await prisma.$transaction(
      async (tx) => {
        const inTx = await tx.consentReceipt.findFirst({
          where: { userId, kind: "ai_full", revokedAt: null },
          orderBy: { createdAt: "desc" },
        });
        if (inTx) return { minted: false, reason: "already_active" } as const;

        // Re-check the revocation inside the transaction too: a revoke can
        // land between the fast-path read and here, and without this the
        // mint would overwrite a decision made a moment earlier.
        if (intent === "heal") {
          const revokedInTx = await tx.consentReceipt.findFirst({
            where: { userId, kind: "ai_full", revokedAt: { not: null } },
            select: { id: true },
          });
          if (revokedInTx)
            return { minted: false, reason: "previously_revoked" } as const;
        }

        const receipt = await tx.consentReceipt.create({
          data: { userId, kind: "ai_full", artefact, signedAt: now },
        });
        return { minted: true, receipt } as const;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (err) {
    // Partial-unique violation — a concurrent grant landed first.
    if (isP2002(err)) return { minted: false, reason: "already_active" };
    throw err;
  }
}
