/**
 * v1.4.40 SB-10 — AI consent receipts CRUD helper.
 *
 * Append-only audit trail. Every grant + revoke mints a fresh row;
 * no updates, no deletes outside of cascade-on-user-delete. A
 * revocation (`withdrawConsent` in `./withdrawal`) writes the current
 * row's `revokedAt` — that single field flip is the only mutation a
 * receipt ever sees. A subsequent re-grant inserts a new row, so the
 * historical chain stays intact for legal review.
 *
 * Source of truth for "is AI active right now?" is
 * `latestActiveReceipt(userId, kind)` returning non-null. Reader
 * routes never inspect older rows.
 */
import { prisma } from "@/lib/db";
import type { ConsentReceiptModel } from "@/generated/prisma/models/ConsentReceipt";
import type { ConsentKind } from "@/lib/validations/consent";
import { isP2002 } from "@/lib/prisma-errors";

export type ConsentReceipt = ConsentReceiptModel;

/**
 * The consent kind for reading documents, lab report scans and typed
 * medication text with an external model. Minted by switching the document
 * auto-read on; required (or the master `ai_full`) by every extraction path.
 * It does not satisfy the Coach or the analysis.
 */
export const AI_EXTRACTION_CONSENT_KIND = "ai_extraction" satisfies ConsentKind;

/**
 * The kinds whose active receipt authorises model-written analysis over the
 * person's own readings (briefing, status notes, narratives, workout
 * paragraphs, reaction lines). When none of these is left active, the
 * regenerable text those surfaces stored is purged.
 */
export const INSIGHTS_CONSENT_KINDS: readonly ConsentKind[] = [
  "ai_insights_only",
  "ai_full",
];

/**
 * Insert a fresh consent receipt for (userId, kind). The caller has
 * already Zod-validated `artefact` (≤ 64 KB) and `signedAt` (ISO-8601).
 *
 * v1.16.16 — the partial unique index `consent_receipts_user_id_kind_
 * active_key` (`WHERE revoked_at IS NULL`, migration 0159) caps the table
 * at one *active* receipt per (user, kind). A plain re-grant of an already
 * active kind would otherwise collide, so the mint runs in a transaction
 * that first revokes any active row of the same kind, then appends the new
 * one. The append-only audit chain is preserved — the superseded row keeps
 * its history with a `revoked_at` marker — and the constraint is satisfied
 * because at most one active row ever exists.
 */
export async function createReceipt(
  userId: string,
  kind: ConsentKind,
  artefact: string,
  signedAt: Date,
): Promise<ConsentReceipt> {
  // `signedAt` is the client-supplied wall-clock for the NEW grant and is
  // only validated as well-formed ISO-8601 — it can legitimately be in the
  // past or out of order with existing rows. The supersede marker on the
  // PRIOR active row must NOT use it: a backdated `signedAt` would stamp the
  // old row's `revoked_at` earlier than its own `signed_at`, inverting the
  // audit chain. Use a server clock for the revocation instead.
  const supersededAt = new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      // Supersede any currently-active receipt of this kind so the fresh
      // grant doesn't collide with the partial unique index. `updateMany`
      // over the active predicate is a no-op when none is active.
      await tx.consentReceipt.updateMany({
        where: { userId, kind, revokedAt: null },
        data: { revokedAt: supersededAt },
      });
      return tx.consentReceipt.create({
        data: {
          userId,
          kind,
          artefact,
          signedAt,
        },
      });
    });
  } catch (err) {
    // Two concurrent FIRST grants (no prior active row) both see
    // `updateMany` match zero rows under Read Committed — neither takes a
    // lock — so both reach `create` and the second trips the partial unique
    // index (migration 0159, `WHERE revoked_at IS NULL`) with P2002. That is
    // success-shaped: the concurrent grant already produced the single active
    // receipt the caller wants. Re-read it and return it rather than letting
    // the violation surface as a generic 500.
    if (isP2002(err)) {
      const winner = await latestActiveReceipt(userId, kind);
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Return the most recent non-revoked receipt for (userId, kind), or
 * `null` if none exists. Ordering is by `createdAt DESC` — the same
 * index direction declared on the schema, so the planner walks the
 * compound index forward without a sort.
 *
 * "Non-revoked" = `revokedAt IS NULL`. A revoked row never resurrects;
 * a new grant must mint a new row.
 */
export async function latestActiveReceipt(
  userId: string,
  kind: ConsentKind,
): Promise<ConsentReceipt | null> {
  return prisma.consentReceipt.findFirst({
    where: { userId, kind, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Return the latest non-revoked receipt across every kind for the
 * user, keyed by kind. Used by `GET /api/consent/ai/latest` when the
 * caller omits the `?kind` query param.
 */
export async function latestActiveReceiptsByKind(
  userId: string,
): Promise<Partial<Record<ConsentKind, ConsentReceipt>>> {
  const rows = await prisma.consentReceipt.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  // First-wins reduce over `createdAt DESC`. `findMany` returns every
  // historical grant for the user; we keep the freshest per kind.
  const out: Partial<Record<ConsentKind, ConsentReceipt>> = {};
  for (const r of rows) {
    const k = r.kind as ConsentKind;
    if (!(k in out)) out[k] = r;
  }
  return out;
}
