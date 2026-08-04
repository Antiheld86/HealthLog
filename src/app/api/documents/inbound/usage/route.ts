/**
 * Document vault: storage usage + effective limits for the calling user.
 *
 * The UI reads this before offering an upload (quota bar above 80 % usage,
 * client-side pre-flight against `maxFileBytes`, picker `accept` list from
 * `acceptedExtensions`). `usedBytes` counts every non-purged row — tombstones
 * still hold TOAST bytes until the purge job reclaims them, so "deleted"
 * bytes are never invisible weight and an undo never changes usage.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import {
  DOCUMENT_ACCEPTED_EXTENSIONS,
  resolveDocumentLimits,
} from "@/lib/documents/upload-policy";
import { resolveOcrCapability } from "@/lib/labs/ocr-capability";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import type { DocumentUsageDto } from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

/**
 * v1.36.x — delegable. The quota gauge is the least of it: this payload also
 * carries the filter bar's condition chips (the record's episodes that hold a
 * live document link) and the index-coverage counts, so without it the vault a
 * delegate may read loses its filters and reads as a flat pile. Every figure is
 * the record's own. The `assistAvailable` flag is an availability boolean of
 * the same integration-adjacent kind `nutrients` already returns — no
 * credential, endpoint or token crosses the wire, and every AI action it would
 * gate stays refused under a switch.
 *
 * No write arm exists on this route.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read");
  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const [limits, rows, linkRows, capability, indexedCount, totalCount] =
    await Promise.all([
      resolveDocumentLimits(user.id),
      prisma.$queryRaw<Array<{ used: bigint }>>`
      SELECT COALESCE(SUM(byte_size), 0)::bigint AS used
      FROM inbound_documents
      WHERE user_id = ${user.id}
    `,
      // Episodes that carry at least one LIVE document link — the filter
      // bar's condition chips. Sourced here (not from the loaded corpus) so
      // a chip exists even when its documents sit pages deep in the
      // timeline; one indexed grouped query, no blobs.
      prisma.documentConditionLink.findMany({
        where: { userId: user.id, document: { deletedAt: null } },
        select: { episodeId: true, episode: { select: { label: true } } },
        distinct: ["episodeId"],
        orderBy: { episodeId: "asc" },
      }),
      // Whether an AI action can run for this caller (assist + indexing share
      // the same provider precondition). Honest availability so the UI never
      // offers what the endpoint would 422.
      resolveOcrCapability(user.id),
      // Content-index coverage: how many live documents are indexed …
      // Scope the count to LIVE documents: a soft-deleted document keeps its
      // index row (cascade fires on hard purge only), so an unscoped count
      // would drift above `totalCount` and read the gauge past 100 %.
      prisma.documentContentIndex.count({
        where: { userId: user.id, document: { deletedAt: null } },
      }),
      // … out of how many live documents there are.
      prisma.inboundDocument.count({
        where: { userId: user.id, deletedAt: null },
      }),
    ]);
  const usedBytes = Number(rows[0]?.used ?? 0);

  annotate({
    action: { name: "documents.vault.usage" },
    meta: { usedBytes, quotaBytes: limits.quotaBytes },
  });

  const payload: DocumentUsageDto = {
    usedBytes,
    quotaBytes: limits.quotaBytes,
    maxFileBytes: limits.maxFileBytes,
    acceptedExtensions: [...DOCUMENT_ACCEPTED_EXTENSIONS],
    linkedEpisodes: linkRows.map((row) => ({
      episodeId: row.episodeId,
      name: row.episode.label,
    })),
    assistAvailable: capability.available,
    contentIndex: {
      enabled: capability.available,
      indexedCount,
      totalCount,
    },
  };
  return apiSuccess(payload);
});
