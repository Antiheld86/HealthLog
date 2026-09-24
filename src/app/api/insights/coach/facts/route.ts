/**
 * GET    /api/insights/coach/facts — list the caller's ACTIVE Coach facts.
 * DELETE /api/insights/coach/facts — "forget all": soft-delete every active
 *                                    fact for the caller.
 *
 * v1.11.1 — the GDPR / "forget what you know about me" surface for the
 * durable Coach facts the assistant extracts during conversations. Facts
 * are server-extracted, not user-authored, so this surface is read +
 * delete only (no POST / PATCH).
 *
 * Ownership: every query is scoped `where: { userId, ... }`, so a caller
 * can only ever see or clear their own facts. The fact text is decrypted
 * on the fly; an undecryptable row (e.g. a key rotated out of the map) is
 * skipped rather than 500ing the whole list — the surface stays available
 * for the rows that DO decrypt.
 *
 * Never AI-gated. The facts are the person's stored data: viewing and
 * deleting them keeps working while the Coach is off for any reason (the
 * operator's switch, the person's own opt-out, no provider, no consent).
 * Erasure that depends on the feature being on is no erasure.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const rows = await prisma.coachFact.findMany({
    where: { userId: user.id, deletedAt: null },
    // Highest-confidence first, then newest — mirrors the injection
    // ordering so the management list reads in the same priority the
    // assistant actually weights the facts.
    orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      category: true,
      factEncrypted: true,
      confidence: true,
      createdAt: true,
    },
  });

  const facts: Array<{
    id: string;
    category: string;
    text: string;
    confidence: number;
    createdAt: Date;
  }> = [];

  for (const row of rows) {
    let text: string;
    try {
      text = decryptFromBytes(row.factEncrypted);
    } catch {
      // Fail closed per row — never surface ciphertext, never 500 the
      // whole list because one row's key id is no longer in the map.
      continue;
    }
    facts.push({
      id: row.id,
      category: row.category,
      text,
      confidence: row.confidence,
      createdAt: row.createdAt,
    });
  }

  annotate({
    action: { name: "coach.facts.listed" },
    meta: { count: facts.length },
  });

  return apiSuccess({ facts });
});

export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();

  // Soft-delete every active fact — keeps the rows for audit while
  // hiding them from injection. `updateMany` scoped to the caller can
  // never touch another user's rows.
  const { count } = await prisma.coachFact.updateMany({
    where: { userId: user.id, deletedAt: null },
    data: { deletedAt: new Date() },
  });

  annotate({
    action: { name: "coach.facts.cleared" },
    meta: { cleared: count },
  });

  return apiSuccess({ cleared: count });
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
