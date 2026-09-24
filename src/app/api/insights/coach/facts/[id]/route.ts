/**
 * DELETE /api/insights/coach/facts/[id] — soft-delete one Coach fact.
 *
 * v1.11.1 — the per-fact "forget this one thing" delete for the durable
 * Coach facts surface.
 *
 * Ownership + existence privacy: the soft-delete uses `updateMany` scoped
 * `where: { id, userId, deletedAt: null }` rather than `update`. A
 * cross-user id, an unknown id, or an already-deleted fact all resolve to
 * a `count: 0` no-op — the route returns `200 { deleted: false }` and
 * never reveals whether the id exists under another account. The matching
 * convention is the idempotent-delete one used elsewhere in the tree
 * (a not-found delete is a successful no-op, not a 404).
 *
 * Never AI-gated, like the collection route: deleting a stored fact keeps
 * working while the Coach is unavailable.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export const DELETE = apiHandler(
  async (_request: NextRequest, ctx: RouteCtx) => {
    const { user } = await requireAuth();

    const { id } = await ctx.params;

    // `updateMany` (not `update`) so an unknown / cross-user / already-soft-
    // deleted id is a 0-count no-op rather than a P2025 throw — the
    // existence channel never leaks across accounts.
    const { count } = await prisma.coachFact.updateMany({
      where: { id, userId: user.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    const deleted = count > 0;

    annotate({
      action: { name: "coach.facts.deleted" },
      meta: { deleted },
    });

    return apiSuccess({ deleted });
  },
);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
