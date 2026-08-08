/**
 * Document vault: restore a soft-deleted (tombstoned) document.
 *
 * Delete is undo-able: the DELETE route tombstones (`deletedAt`), the UI
 * shows an "Undo" toast that calls this route, and the daily purge job
 * physically removes tombstones older than the 30-day grace window. This
 * route clears the tombstone; it answers 409 when the row is gone (purged —
 * indistinguishable from never-existed by construction, and owner-scoped
 * either way) or when restoring would collide with a live duplicate of the
 * same bytes (the `inbound_documents_user_sha_live` partial unique index).
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  loadConditionLinks,
  loadDocumentEncounterLinks,
} from "@/lib/documents/links";
import { serialiseDocumentDetail } from "@/lib/documents/store";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { isP2002 } from "@/lib/prisma-errors";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import type { InboundDocumentStatus } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** Shares the write posture of the other owner-scoped document mutations. */
const WRITE_LIMIT_PER_HOUR = 240;
const WRITE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Post-restore lifecycle status, derived from the staged facts: no facts →
 * STORED, any PENDING → EXTRACTED, otherwise every fact was acted on →
 * CONFIRMED. (DELETE stamped DISCARDED; the prior status is not persisted.)
 */
function restoredStatus(
  facts: Array<{ status: string }>,
): InboundDocumentStatus {
  if (facts.length === 0) return "STORED";
  return facts.some((f) => f.status === "PENDING") ? "EXTRACTED" : "CONFIRMED";
}

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const rl = await checkRateLimit(
      `documents-write:${user.id}`,
      WRITE_LIMIT_PER_HOUR,
      WRITE_WINDOW_MS,
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

    const { id } = await params;
    const row = await prisma.inboundDocument.findFirst({
      where: { id, userId: user.id },
      omit: { contentEncrypted: true },
      include: { facts: { orderBy: { createdAt: "asc" } } },
    });

    if (!row) {
      // Purged (past the 30-day grace) or never existed — the tombstone is
      // gone either way, so the undo window is over: 409, not 404.
      return apiError("This document can no longer be restored.", 409, {
        errorCode: "documents.inbound.restoreGone",
        reason: "purged",
      });
    }

    if (row.deletedAt === null) {
      // Already live — restoring twice is a no-op, not an error (the undo
      // toast may fire after a concurrent restore).
      const [links, visitLinks] = await Promise.all([
        loadConditionLinks(user.id, [row.id]),
        loadDocumentEncounterLinks(user.id, [row.id]),
      ]);
      return apiSuccess(
        serialiseDocumentDetail(
          row,
          row.facts,
          links.get(row.id) ?? [],
          false,
          null,
          false,
          visitLinks.get(row.id) ?? [],
        ),
      );
    }

    // A live duplicate of the same bytes blocks the restore (the partial
    // unique index would reject it; check first for a clean 409).
    if (row.contentSha256) {
      const conflict = await prisma.inboundDocument.findFirst({
        where: {
          userId: user.id,
          contentSha256: row.contentSha256,
          deletedAt: null,
          id: { not: row.id },
        },
        select: { id: true },
      });
      if (conflict) {
        return apiError("An identical document is already stored.", 409, {
          errorCode: "documents.inbound.restoreDuplicate",
          reason: "duplicateExists",
          existingId: conflict.id,
        });
      }
    }

    try {
      await prisma.inboundDocument.update({
        where: { id: row.id },
        data: { deletedAt: null, status: restoredStatus(row.facts) },
      });
    } catch (err) {
      if (isP2002(err)) {
        // Raced a concurrent identical upload into the partial unique index.
        return apiError("An identical document is already stored.", 409, {
          errorCode: "documents.inbound.restoreDuplicate",
          reason: "duplicateExists",
        });
      }
      throw err;
    }

    const restored = await prisma.inboundDocument.findFirstOrThrow({
      where: { id: row.id },
      omit: { contentEncrypted: true },
      include: { facts: { orderBy: { createdAt: "asc" } } },
    });
    const [links, visitLinks] = await Promise.all([
      loadConditionLinks(user.id, [restored.id]),
      loadDocumentEncounterLinks(user.id, [restored.id]),
    ]);

    await auditLog("documents.inbound.restore", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { documentId: restored.id },
    });

    annotate({
      action: { name: "documents.vault.restore" },
      meta: { documentId: restored.id },
    });

    return apiSuccess(
      serialiseDocumentDetail(
        restored,
        restored.facts,
        links.get(restored.id) ?? [],
        false,
        null,
        false,
        visitLinks.get(restored.id) ?? [],
      ),
    );
  },
);
