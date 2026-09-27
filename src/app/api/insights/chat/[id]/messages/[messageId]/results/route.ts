/**
 * GET /api/insights/chat/[id]/messages/[messageId]/results — the tables of
 * values one assistant message read, decrypted for their owner.
 *
 * A data read, never AI-gated: the tables are the person's stored record,
 * readable while the Coach is unavailable for any reason, like the
 * conversation they belong to. Narrowed exactly like
 * `GET /api/insights/chat/[id]`: the message must sit in a conversation the
 * caller owns, and a foreign or unknown id is 404, never 403.
 *
 * Each table is served whole or withheld with a reason: `module_disabled`
 * when its domain's module is switched off for the record now (the table is
 * not even decrypted), `unavailable` when the stored tables cannot be read.
 * The list follows the order of `metricSource.results` on the message.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { resolveModuleMap } from "@/lib/modules/gate";
import { readMessageResults } from "@/lib/ai/coach/persistence";
import { isCoachDomainWithheld } from "@/lib/ai/coach/results/domain-module";

interface RouteCtx {
  params: Promise<{ id: string; messageId: string }>;
}

export const GET = apiHandler(async (_request: NextRequest, ctx: RouteCtx) => {
  const auth = await requireAuth();
  const userId = auth.user.id;
  const { id, messageId } = await ctx.params;
  if (!id || !messageId) return apiError("coach.message.notFound", 404);

  const modules = await resolveModuleMap(userId);
  const results = await readMessageResults(userId, id, messageId, (domain) =>
    isCoachDomainWithheld(domain, modules),
  );
  if (!results) return apiError("coach.message.notFound", 404);

  annotate({
    action: { name: "insights.coach.results.read" },
    meta: {
      conversationId: id,
      tables: results.length,
      withheld: results.filter((entry) => "withheld" in entry).length,
    },
  });

  return apiSuccess({ results });
});

export const dynamic = "force-dynamic";
