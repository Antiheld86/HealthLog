/**
 * Document ⇄ condition link helpers shared by the vault routes.
 *
 * One grouped query per page (no N+1), owner-scoped everywhere: every episode
 * id a client sends is re-narrowed against the caller's live episodes before
 * it can land in `document_condition_links`.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { listTargetsBySource, replaceTargets } from "@/lib/links";
import type { DocumentConditionLinkDto } from "@/lib/validations/inbound-documents";

/**
 * Load the condition links for a page of documents in ONE grouped query.
 * Returns a map documentId → link DTOs (documents without links are absent).
 */
export async function loadConditionLinks(
  userId: string,
  documentIds: string[],
): Promise<Map<string, DocumentConditionLinkDto[]>> {
  const map = new Map<string, DocumentConditionLinkDto[]>();
  if (documentIds.length === 0) return map;
  // `includeDeletedTargets` keeps the long-standing behaviour: the chip has
  // always come off a relation join with no tombstone filter, so a document
  // filed against a condition the person later deleted still shows it.
  const byDocument = await listTargetsBySource(prisma, {
    userId,
    sourceKind: "document",
    sourceIds: documentIds,
    targetKind: "conditionEpisode",
    includeDeletedTargets: true,
  });
  for (const [documentId, targets] of byDocument) {
    map.set(
      documentId,
      targets.map((target) => ({ episodeId: target.id, name: target.label })),
    );
  }
  return map;
}

/**
 * Narrow a client-sent episode-id list to the caller's LIVE episodes.
 * Returns the deduplicated owned ids, or null when any id is unknown /
 * foreign / deleted — the caller answers with a 404-shaped refusal (an
 * attacker probing another user's episode ids learns nothing beyond
 * "not found").
 */
export async function narrowOwnedEpisodeIds(
  userId: string,
  episodeIds: string[],
): Promise<string[] | null> {
  const unique = [...new Set(episodeIds)];
  if (unique.length === 0) return [];
  const owned = await prisma.illnessEpisode.findMany({
    where: { id: { in: unique }, userId, deletedAt: null },
    select: { id: true },
  });
  if (owned.length !== unique.length) return null;
  return unique;
}

/**
 * Replace-set a document's condition links inside the given transaction-ish
 * client: delete links no longer in the set, insert the missing ones.
 *
 * `episodeIds` should already be owner-narrowed (`narrowOwnedEpisodeIds`), so
 * the route can answer a foreign id with the 404-shaped refusal it does today.
 * The link service narrows them again regardless — the routes decide the reply,
 * the service decides what reaches the table.
 */
export async function replaceConditionLinks(
  tx: Prisma.TransactionClient,
  userId: string,
  documentId: string,
  episodeIds: string[],
): Promise<void> {
  await replaceTargets(tx, {
    userId,
    sourceKind: "document",
    sourceId: documentId,
    targetKind: "conditionEpisode",
    targetIds: episodeIds,
  });
}
