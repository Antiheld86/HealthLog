/**
 * Document vault: bulk actions over up to 100 owner-scoped documents.
 *
 * `{ ids[], action, kind?, episodeId? }` → a per-id result array. Actions:
 * `setKind` (recategorise), `linkEpisode` / `unlinkEpisode` (condition
 * links), `delete` (tombstone, undo-able), `restore` (clear tombstone). A
 * partial failure never aborts the batch — each id reports `ok` or a short
 * machine reason. Every id is narrowed to the caller; a foreign id reads as
 * "notFound", exactly like the single-document routes.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { linkTargets, unlinkTargets } from "@/lib/links";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { isP2002 } from "@/lib/prisma-errors";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  documentBulkSchema,
  type DocumentBulkResultDto,
} from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

/**
 * One bulk call covers up to 100 rows, so the bucket is tighter than the
 * single-row write bucket (240/h) while allowing the same overall throughput.
 */
const BULK_LIMIT_PER_HOUR = 60;
const BULK_WINDOW_MS = 60 * 60 * 1000;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const rl = await checkRateLimit(
    `documents-bulk:${user.id}`,
    BULK_LIMIT_PER_HOUR,
    BULK_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests. Try again later.", 429, {
      errorCode: "documents.inbound.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = documentBulkSchema.safeParse(body);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422);
  }
  const { ids, action, kind, episodeId } = parsed.data;
  const uniqueIds = [...new Set(ids)];

  // Episode actions: the target episode must be a LIVE episode of the caller.
  if (action === "linkEpisode" || action === "unlinkEpisode") {
    const episode = await prisma.illnessEpisode.findFirst({
      where: { id: episodeId!, userId: user.id, deletedAt: null },
      select: { id: true },
    });
    if (!episode) {
      return apiError("Episode not found", 404, {
        errorCode: "documents.inbound.episodeNotFound",
      });
    }
  }

  // One owner-scoped sweep resolves every id's current state; per-id work
  // then never touches a row the caller does not own.
  const owned = await prisma.inboundDocument.findMany({
    where: { id: { in: uniqueIds }, userId: user.id },
    select: { id: true, deletedAt: true, contentSha256: true },
  });
  const byId = new Map(owned.map((d) => [d.id, d]));

  const results: DocumentBulkResultDto[] = [];
  for (const id of uniqueIds) {
    const row = byId.get(id);
    if (!row) {
      results.push({ id, ok: false, error: "notFound" });
      continue;
    }
    try {
      switch (action) {
        case "setKind": {
          if (row.deletedAt !== null) {
            results.push({ id, ok: false, error: "notFound" });
            continue;
          }
          await prisma.inboundDocument.update({
            where: { id },
            data: { kind: kind! },
          });
          break;
        }
        case "linkEpisode": {
          if (row.deletedAt !== null) {
            results.push({ id, ok: false, error: "notFound" });
            continue;
          }
          await linkTargets(prisma, {
            userId: user.id,
            sourceKind: "document",
            sourceId: id,
            targetKind: "conditionEpisode",
            targetIds: [episodeId!],
          });
          break;
        }
        case "unlinkEpisode": {
          await unlinkTargets(prisma, {
            userId: user.id,
            sourceKind: "document",
            sourceId: id,
            targetKind: "conditionEpisode",
            targetIds: [episodeId!],
          });
          break;
        }
        case "delete": {
          if (row.deletedAt !== null) {
            // Already tombstoned — deleting twice is a no-op success.
            break;
          }
          await prisma.inboundDocument.update({
            where: { id },
            data: { deletedAt: new Date(), status: "DISCARDED" },
          });
          break;
        }
        case "restore": {
          if (row.deletedAt === null) {
            // Already live — restoring twice is a no-op success.
            break;
          }
          if (row.contentSha256) {
            const conflict = await prisma.inboundDocument.findFirst({
              where: {
                userId: user.id,
                contentSha256: row.contentSha256,
                deletedAt: null,
                id: { not: id },
              },
              select: { id: true },
            });
            if (conflict) {
              results.push({ id, ok: false, error: "conflict" });
              continue;
            }
          }
          const facts = await prisma.extractedFact.findMany({
            where: { documentId: id, userId: user.id },
            select: { status: true },
          });
          const status =
            facts.length === 0
              ? "STORED"
              : facts.some((f) => f.status === "PENDING")
                ? "EXTRACTED"
                : "CONFIRMED";
          await prisma.inboundDocument.update({
            where: { id },
            data: { deletedAt: null, status },
          });
          break;
        }
      }
      results.push({ id, ok: true, error: null });
    } catch (err) {
      if (isP2002(err)) {
        results.push({ id, ok: false, error: "conflict" });
        continue;
      }
      throw err;
    }
  }

  const okCount = results.filter((r) => r.ok).length;

  await auditLog("documents.inbound.bulk", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { action, requested: uniqueIds.length, succeeded: okCount },
  });

  annotate({
    action: { name: "documents.vault.bulk" },
    meta: { bulkAction: action, requested: uniqueIds.length, ok: okCount },
  });

  return apiSuccess({ results });
});
