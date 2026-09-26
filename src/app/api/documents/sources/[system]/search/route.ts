/**
 * Document picker (#1038): search one connected document archive.
 *
 * `q` searches the document's name (the title in Paperless-ngx, the name in
 * Papra), `tag` narrows to one of the source's tags by its id, `from` / `to`
 * to a date range (inclusive), `page` pages through 25 at a time. The answer
 * is a minimal row per document (source id, title, date, tag names, size when
 * the source says it) plus what HealthLog already holds under that source key:
 * `new`, `imported` (with the vault document's id) or `deleted` (the person
 * deleted it here; importing it again is refused). Nothing is stored.
 *
 * Sixty searches a minute, shared with the tag read. Cookie-only and
 * owner-only; see `admitDocumentSourceCaller`.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  apiValidationError,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { findSourceKeyStates } from "@/lib/documents/source-key";
import type { SourceListItem } from "@/lib/documents/sources/clients";
import { openConnection } from "@/lib/documents/sources/connections";
import {
  admitDocumentSourceCaller,
  checkSearchRateLimit,
  responseForSourceFailure,
  sourceErrorResponse,
  systemParam,
} from "@/lib/documents/sources/route-support";
import type {
  DocumentSourceResultDto,
  DocumentSourceSearchDto,
} from "@/lib/documents/sources/types";
import { annotate } from "@/lib/logging/context";
import { rateLimitHeaders } from "@/lib/rate-limit";
import { documentSourceSearchSchema } from "@/lib/validations/document-sources";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ system: string }> };

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const auth = await requireAuth();
    const refused = await admitDocumentSourceCaller(auth);
    if (refused) return refused;
    const system = await systemParam(params);
    if (system instanceof Response) return system;
    const userId = auth.user.id;

    const url = new URL(request.url);
    const parsed = documentSourceSearchSchema.safeParse({
      q: url.searchParams.get("q") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
    });
    if (!parsed.success) {
      return apiValidationError(
        "Invalid search",
        sanitiseZodIssues(parsed.error.issues),
        422,
      );
    }
    const { q, tag, from, to, page } = parsed.data;

    const rl = await checkSearchRateLimit(userId);
    if (!rl.allowed) {
      return sourceErrorResponse(
        "rateLimited",
        undefined,
        rateLimitHeaders(rl),
      );
    }

    let found: { items: SourceListItem[]; hasMore: boolean };
    try {
      const client = await openConnection(userId, system);
      found = await client.search({
        q,
        tagId: tag ?? null,
        from: from ?? null,
        to: to ?? null,
        page,
      });
    } catch (err) {
      return responseForSourceFailure(err);
    }

    const states = await findSourceKeyStates(
      userId,
      system,
      found.items.map((item) => item.sourceId),
    );
    const results: DocumentSourceResultDto[] = found.items.map((item) => {
      const held = states.get(item.sourceId);
      return {
        sourceId: item.sourceId,
        title: item.title,
        date: item.date,
        tags: item.tags,
        sizeBytes: item.sizeBytes,
        state: held?.state ?? "new",
        documentId: held?.state === "imported" ? held.documentId : null,
      };
    });

    // Counts only: the query and the titles are the person's own words and
    // stay out of the wide event.
    annotate({
      action: { name: "documents.sources.search" },
      meta: {
        system,
        page,
        count: results.length,
        filtered: Boolean(q || tag || from || to),
      },
    });

    const body: DocumentSourceSearchDto = {
      results,
      page,
      hasMore: found.hasMore,
    };
    return apiSuccess(body);
  },
);
