/**
 * Document picker (#1038): import one picked document from a connected
 * archive into the vault.
 *
 * One document per request, so the sheet can show each one's progress and
 * result, and no single request holds more than one file in memory. The path:
 *
 *   1. the link target, when the picker was opened from a record, must be one
 *      of the person's own live records (404 before anything leaves the
 *      server);
 *   2. the source key answers first, without a download: a document already
 *      imported (or already holding this key as an alias) is a `duplicate`,
 *      and one the person deleted here is `deleted` — nothing is fetched and
 *      nothing is stored, exactly as the token upload answers the same key;
 *   3. only then the vault's own upload allowance (60 an hour, shared with
 *      uploads from the web and the phone) and an upload slot are taken, the
 *      document's details and its original file are fetched (bounded by the
 *      vault's per-file cap), and the file goes through `ingestDocument`, the
 *      same function the upload route stores through: type check, content
 *      dedup, quota, provenance (`sourceSystem` / `sourceId`), the background
 *      jobs;
 *   4. the document is linked to the record through `src/lib/links/`.
 *
 * AI reading follows the person's own setting, unlike the token upload's
 * default of holding it back: the person picked this document by hand, as
 * deliberately as an upload. The hourly allowance and the daily AI budget
 * bound it either way.
 *
 * Cookie-only and owner-only; see `admitDocumentSourceCaller`.
 */
import { Buffer } from "node:buffer";

import { NextRequest, NextResponse } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiValidationError,
  getClientIp,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { getAiCapability } from "@/lib/ai/capabilities/gate";
import { prisma } from "@/lib/db";
import {
  ingestDocument,
  personalUploadBucket,
  UPLOAD_LIMIT_PER_HOUR,
  UPLOAD_WINDOW_MS,
} from "@/lib/documents/ingest";
import { findSourceKey, type SourceKeyMatch } from "@/lib/documents/source-key";
import { clientFor, loadConnection } from "@/lib/documents/sources/connections";
import {
  admitDocumentSourceCaller,
  responseForSourceFailure,
  sourceErrorResponse,
  systemParam,
} from "@/lib/documents/sources/route-support";
import type {
  DocumentImportOutcome,
  DocumentPickerLinkKind,
  DocumentSourceImportDto,
} from "@/lib/documents/sources/types";
import {
  acquireDocumentUploadSlot,
  resolveDocumentLimits,
} from "@/lib/documents/upload-policy";
import { linkTargets } from "@/lib/links";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { documentSourceImportSchema } from "@/lib/validations/document-sources";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ system: string }> };

interface LinkTarget {
  kind: DocumentPickerLinkKind;
  id: string;
}

/** Is the record the picker was opened from one of the person's live ones? */
async function ownsLinkTarget(
  userId: string,
  link: LinkTarget,
): Promise<boolean> {
  const where = { id: link.id, userId, deletedAt: null };
  const select = { id: true } as const;
  switch (link.kind) {
    case "conditionEpisode":
      return (
        (await prisma.illnessEpisode.findFirst({ where, select })) !== null
      );
    case "encounter":
      return (await prisma.encounter.findFirst({ where, select })) !== null;
    case "vaccination":
      return (
        (await prisma.vaccinationRecord.findFirst({ where, select })) !== null
      );
  }
}

/** File the document against the record, from the record's side. */
async function linkDocument(
  userId: string,
  link: LinkTarget | undefined,
  documentId: string,
): Promise<boolean> {
  if (!link) return false;
  const result = await prisma.$transaction((tx) =>
    linkTargets(tx, {
      userId,
      sourceKind: link.kind,
      sourceId: link.id,
      targetKind: "document",
      targetIds: [documentId],
    }),
  );
  return !result.unknownSource && result.unknownTargetIds.length === 0;
}

function respond(
  system: string,
  outcome: DocumentImportOutcome,
  documentId: string | null,
  linked: boolean,
): NextResponse {
  annotate({
    action: { name: "documents.sources.import" },
    meta: { system, outcome, linked, documentId },
  });
  const data: DocumentSourceImportDto = { outcome, documentId, linked };
  return NextResponse.json(
    { data, error: null },
    { status: outcome === "imported" ? 201 : 200 },
  );
}

/** A key the vault already holds: link a live one, never revive a deleted one. */
async function answerHeldKey(
  system: string,
  userId: string,
  link: LinkTarget | undefined,
  match: SourceKeyMatch,
): Promise<NextResponse> {
  if (match.state === "deleted") {
    return respond(system, "deleted", match.id, false);
  }
  const linked = await linkDocument(userId, link, match.document.id);
  return respond(system, "duplicate", match.document.id, linked);
}

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const auth = await requireAuth();
    const refused = await admitDocumentSourceCaller(auth);
    if (refused) return refused;
    const system = await systemParam(params);
    if (system instanceof Response) return system;
    const userId = auth.user.id;

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 4 * 1024,
    });
    if (jsonError) return jsonError;
    const parsed = documentSourceImportSchema.safeParse(body);
    if (!parsed.success) {
      return apiValidationError(
        "Invalid import request",
        sanitiseZodIssues(parsed.error.issues),
        422,
      );
    }
    const { sourceId, kind, link } = parsed.data;

    const row = await loadConnection(userId, system);
    if (!row) return sourceErrorResponse("notConnected");
    let client;
    try {
      client = clientFor(row);
    } catch (err) {
      return responseForSourceFailure(err);
    }

    if (link && !(await ownsLinkTarget(userId, link))) {
      return sourceErrorResponse("linkTargetNotFound");
    }

    // The source key answers before anything is downloaded or charged.
    const held = await findSourceKey(userId, system, sourceId);
    if (held) return answerHeldKey(system, userId, link, held);

    const rl = await checkRateLimit(
      personalUploadBucket(userId),
      UPLOAD_LIMIT_PER_HOUR,
      UPLOAD_WINDOW_MS,
    );
    if (!rl.allowed) {
      return apiError("Too many uploads. Try again later.", 429, {
        errorCode: "documents.inbound.rateLimited",
        headers: rateLimitHeaders(rl),
      });
    }

    const release = acquireDocumentUploadSlot(userId);
    if (!release) {
      return apiError(
        "Too many uploads are already in progress. Try again shortly.",
        429,
        {
          errorCode: "documents.inbound.uploadBusy",
          reason: "uploadBusy",
          headers: { "Retry-After": "1" },
        },
      );
    }

    try {
      const limits = await resolveDocumentLimits(userId);
      let meta;
      let file;
      try {
        meta = await client.document(sourceId);
        file = await client.download(sourceId, limits.maxFileBytes);
      } catch (err) {
        return responseForSourceFailure(err);
      }

      const result = await ingestDocument({
        userId,
        scoped: false,
        ipAddress: getClientIp(request),
        bytes: Buffer.from(file.bytes),
        filename: meta.filename ?? file.filename,
        title: meta.title,
        kind: kind ?? null,
        documentDate: meta.date,
        episodeIds: [],
        encounterIds: [],
        sourceSystem: system,
        sourceId,
        aiDeferred: false,
        sourceKeyChecked: true,
        limits,
        // The import is data; only the summary queued after a fresh insert
        // follows the capability (and the person's auto-read setting).
        documentAi: () => getAiCapability("documentAi"),
      });

      switch (result.kind) {
        case "sourceKey":
          return answerHeldKey(system, userId, link, result.match);
        case "duplicate": {
          // The same bytes were already in the vault (an upload, or another
          // archive); the key is now remembered for that document.
          const linked = await linkDocument(userId, link, result.document.id);
          return respond(system, "duplicate", result.document.id, linked);
        }
        case "stored": {
          const linked = await linkDocument(userId, link, result.document.id);
          return respond(system, "imported", result.document.id, linked);
        }
        case "tooLarge":
          return apiError("File is too large.", 413, {
            errorCode: "documents.inbound.fileTooLarge",
            reason: "fileTooLarge",
            maxFileBytes: result.maxFileBytes,
          });
        case "empty":
        case "unsupportedType":
          return apiError("This file type is not supported.", 415, {
            errorCode: "documents.inbound.fileType",
            reason: "unsupportedType",
          });
        case "quotaExceeded":
          return apiError("Storage quota exceeded.", 413, {
            errorCode: "documents.inbound.quotaExceeded",
            reason: "quotaExceeded",
            quotaBytes: result.quotaBytes,
            usedBytes: result.usedBytes,
          });
        case "aliasLimit":
          return apiError(
            "This file is already stored under too many source ids.",
            409,
            { errorCode: "documents.inbound.sourceAliasLimit" },
          );
        case "episodeNotFound":
        case "encounterNotFound":
          // No pre-links are passed on this path; unreachable, but a result
          // the switch does not name must not fall through silently.
          return sourceErrorResponse("linkTargetNotFound");
      }
    } finally {
      release();
    }
  },
);
