/**
 * Document vault: serve a document's encrypted preview thumbnail.
 *
 * The thumbnail is a small JPEG (~320px long edge) rendered in the background
 * from the original and stored encrypted at rest
 * (`DocumentThumbnail.thumbnailEncrypted`, AES-256-GCM). This route is the ONLY
 * path that decrypts and serves it. Owner-scoped + module-gated; the bytes are
 * PHI: never logged, never served cross-user, fail-closed on a decrypt error.
 *
 * Serving posture is fixed and singular: we only ever store JPEG, so the
 * response is always `Content-Type: image/jpeg` + `nosniff` — zero
 * misclassification surface, no `attachment` branch. It is loaded as an `<img>`
 * subresource on the vault page (governed by the page CSP `img-src 'self'`), so
 * it needs NO proxy carve-out — unlike `/original`, which is framed.
 *
 * A cache MISS (no thumbnail row yet — freshly uploaded, still rendering, or an
 * unsupported type) is a 404; the card falls back to its kind icon. The route
 * never generates synchronously, preserving the async never-block contract.
 */
import { NextResponse } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { decryptThumbnail } from "@/lib/documents/store";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

type RouteParams = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/**
 * Decrypting a thumbnail is cheap CPU work on PHI, but a virtualized grid
 * legitimately fires many at once — so the per-user ceiling is higher than
 * `/original`'s. It is a self-DoS backstop only (the route is owner-scoped, so
 * there is no cross-user abuse vector).
 */
const THUMBNAIL_READ_LIMIT_PER_HOUR = 3000;
const THUMBNAIL_READ_WINDOW_MS = 60 * 60 * 1000;

/**
 * v1.36.x — delegable. The vault grid is a wall of thumbnails, so a list a
 * delegate may read whose tiles all 403 is the list without the part that
 * makes it browsable. The thumbnail carries no more than the document it
 * belongs to, which the same delegate may open.
 *
 * The bucket keys on the ACTOR, following `medications/compliance`: this read
 * spends decryption CPU, so a delegate burns their own allowance rather than
 * the owner's, and cannot collect a fresh one by switching records.
 */
export const GET = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { user, actor } = await requireRecordAuth("read", "documents");

    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const rl = await checkRateLimit(
      `documents-thumbnail:${actor.id}`,
      THUMBNAIL_READ_LIMIT_PER_HOUR,
      THUMBNAIL_READ_WINDOW_MS,
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
    // Owner-scoped: the userId narrows the document so a cuid guess cannot
    // reach another user's thumbnail. A cookie session and a Bearer token both
    // resolve through requireAuth(); neither can cross the userId boundary.
    // The thumbnail is loaded through the 1:1 relation on the owned document —
    // both the document and its thumbnail are userId-scoped.
    const document = await prisma.inboundDocument.findFirst({
      where: { id, userId: user.id, deletedAt: null },
      select: {
        id: true,
        thumbnail: { select: { thumbnailEncrypted: true, byteSize: true } },
      },
    });
    if (!document || !document.thumbnail) {
      // Missing document OR no thumbnail yet — both 404; the card shows its
      // kind icon. Do not distinguish the two (no existence oracle).
      return apiError("Thumbnail not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    let bytes: Buffer;
    try {
      bytes = decryptThumbnail(document.thumbnail.thumbnailEncrypted);
    } catch {
      // Fail closed — never fall back to the raw ciphertext. The reason (bad /
      // missing key id) is logged by the annotation, never the bytes.
      annotate({
        action: { name: "documents.inbound.thumbnail.decryptFailed" },
        meta: { documentId: document.id },
      });
      return apiError("Could not read the stored thumbnail", 500, {
        errorCode: "documents.inbound.decryptFailed",
      });
    }

    annotate({
      action: { name: "documents.inbound.thumbnail.get" },
      meta: { documentId: document.id, bytes: bytes.byteLength },
    });

    return new NextResponse(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        // We only ever store JPEG — the type is fixed and authoritative.
        "Content-Type": "image/jpeg",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": "inline",
        // The type is authoritative — never MIME-sniffed.
        "X-Content-Type-Options": "nosniff",
        // Private PHI — never cache in a shared / disk cache.
        "Cache-Control": "private, no-store",
      },
    });
  },
);
