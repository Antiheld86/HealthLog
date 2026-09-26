/**
 * Document picker (#1038): test the saved connection to one document archive.
 *
 * One request to the source with the stored token, answered `{ ok, latencyMs }`
 * or with the reason it failed (`meta.errorCode`, and `meta.upstreamStatus`
 * when the source answered at all; its body is never passed on). A success
 * stamps `lastVerifiedAt`. Shares the save's allowance of ten a minute.
 *
 * Cookie-only and owner-only; see `admitDocumentSourceCaller`.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import {
  markVerified,
  openConnection,
} from "@/lib/documents/sources/connections";
import { DocumentSourceError } from "@/lib/documents/sources/http";
import {
  admitDocumentSourceCaller,
  checkConnectRateLimit,
  responseForSourceFailure,
  sourceErrorResponse,
  systemParam,
} from "@/lib/documents/sources/route-support";
import { annotate } from "@/lib/logging/context";
import { rateLimitHeaders } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ system: string }> };

export const POST = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const auth = await requireAuth();
    const refused = await admitDocumentSourceCaller(auth);
    if (refused) return refused;
    const system = await systemParam(params);
    if (system instanceof Response) return system;
    const userId = auth.user.id;
    annotate({ action: { name: "documents.sources.test" }, meta: { system } });

    const rl = await checkConnectRateLimit(userId);
    if (!rl.allowed) {
      return sourceErrorResponse(
        "rateLimited",
        undefined,
        rateLimitHeaders(rl),
      );
    }

    const start = performance.now();
    try {
      const client = await openConnection(userId, system);
      await client.test();
    } catch (err) {
      if (err instanceof DocumentSourceError) {
        annotate({ meta: { refused: err.code } });
      }
      return responseForSourceFailure(err);
    }
    const latencyMs = Math.round(performance.now() - start);
    const verifiedAt = await markVerified(userId, system);
    return apiSuccess({
      ok: true,
      latencyMs,
      lastVerifiedAt: verifiedAt.toISOString(),
    });
  },
);
