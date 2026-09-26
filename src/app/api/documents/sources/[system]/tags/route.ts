/**
 * Document picker (#1038): the tags of one connected document archive, for the
 * picker's tag filter. The first 250 by name, as `{ id, name }` in the
 * source's own ids. Shares the search allowance (60 a minute).
 *
 * Cookie-only and owner-only; see `admitDocumentSourceCaller`.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { openConnection } from "@/lib/documents/sources/connections";
import {
  admitDocumentSourceCaller,
  checkSearchRateLimit,
  responseForSourceFailure,
  sourceErrorResponse,
  systemParam,
} from "@/lib/documents/sources/route-support";
import { annotate } from "@/lib/logging/context";
import { rateLimitHeaders } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ system: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const auth = await requireAuth();
    const refused = await admitDocumentSourceCaller(auth);
    if (refused) return refused;
    const system = await systemParam(params);
    if (system instanceof Response) return system;
    annotate({ action: { name: "documents.sources.tags" }, meta: { system } });

    const rl = await checkSearchRateLimit(auth.user.id);
    if (!rl.allowed) {
      return sourceErrorResponse(
        "rateLimited",
        undefined,
        rateLimitHeaders(rl),
      );
    }

    try {
      const client = await openConnection(auth.user.id, system);
      return apiSuccess({ tags: await client.tags() });
    } catch (err) {
      return responseForSourceFailure(err);
    }
  },
);
