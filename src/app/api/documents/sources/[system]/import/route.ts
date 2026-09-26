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
 *   3. only then is the source asked (on the search allowance, like every
 *      request to it) and an upload slot taken. One import per key and person
 *      runs at a time under an advisory lock, so a double click downloads the
 *      document once. The details and the original file are fetched (bounded
 *      by the vault's per-file cap); only a file that arrived is charged to
 *      the vault's own upload allowance (60 an hour, shared with uploads from
 *      the web and the phone), and it goes through `ingestDocument`, the same
 *      function the upload route stores through: type check, content dedup,
 *      quota, provenance (`sourceSystem` / `sourceId` / `sourceInstance`), the
 *      background jobs;
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
import {
  checkSourceLookupRateLimit,
  findSourceKey,
  type SourceKeyMatch,
} from "@/lib/documents/source-key";
import type { SourceClient } from "@/lib/documents/sources/clients";
import { clientFor, loadConnection } from "@/lib/documents/sources/connections";
import {
  admitDocumentSourceCaller,
  checkSearchRateLimit,
  responseForSourceFailure,
  sourceErrorResponse,
  systemParam,
} from "@/lib/documents/sources/route-support";
import {
  isSourceDocumentId,
  type DocumentImportOutcome,
  type DocumentPickerLinkKind,
  type DocumentPickerSystem,
  type DocumentSourceImportDto,
} from "@/lib/documents/sources/types";
import {
  acquireDocumentUploadSlot,
  resolveDocumentLimits,
} from "@/lib/documents/upload-policy";
import { linkTargets } from "@/lib/links";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { documentSourceImportSchema } from "@/lib/validations/document-sources";
import type { InboundDocumentKindValue } from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ system: string }> };

/** How long an import waits for a database connection to hold its lock on. */
const IMPORT_LOCK_WAIT_MS = 10_000;
/** Longest a single import may hold its key: the download plus the store. */
const IMPORT_LOCK_HOLD_MS = 150_000;

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
    // Only an id this system could have issued goes into a request path.
    if (!isSourceDocumentId(system, sourceId)) {
      return apiError("Not a document id of this archive.", 422);
    }

    const row = await loadConnection(userId, system);
    if (!row) return sourceErrorResponse("notConnected");
    let client;
    try {
      client = clientFor(row);
    } catch (err) {
      return responseForSourceFailure(err);
    }
    const instance = client.instance;

    if (link && !(await ownsLinkTarget(userId, link))) {
      return sourceErrorResponse("linkTargetNotFound");
    }

    // The source key answers before anything is downloaded or charged, on the
    // same metered lookup allowance the upload's key check draws on.
    const lookupRl = await checkSourceLookupRateLimit(
      false,
      auth.session.id,
      userId,
    );
    if (!lookupRl.allowed) {
      return sourceErrorResponse(
        "rateLimited",
        undefined,
        rateLimitHeaders(lookupRl),
      );
    }
    const held = await findSourceKey(userId, system, sourceId, instance);
    if (held) return answerHeldKey(system, userId, link, held);

    // A request to the source counts against the search allowance like any
    // other; the upload allowance is charged only once a file arrived.
    const fetchRl = await checkSearchRateLimit(userId);
    if (!fetchRl.allowed) {
      return sourceErrorResponse(
        "rateLimited",
        undefined,
        rateLimitHeaders(fetchRl),
      );
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
      // One import of one key at a time per person: a second tab or a double
      // click waits here, then finds the key the first one stored, so the
      // document is downloaded once. The lock is transaction-scoped and the
      // transaction holds nothing else; the store runs in its own.
      return await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT 1 AS locked
            FROM pg_advisory_xact_lock(hashtextextended(${`documents-import:${userId}:${system}:${instance}:${sourceId}`}, 0))
          `;
          const raced = await findSourceKey(userId, system, sourceId, instance);
          if (raced) return answerHeldKey(system, userId, link, raced);
          return importOne({
            request,
            client,
            userId,
            system,
            instance,
            sourceId,
            kind: kind ?? null,
            link,
          });
        },
        { maxWait: IMPORT_LOCK_WAIT_MS, timeout: IMPORT_LOCK_HOLD_MS },
      );
    } finally {
      release();
    }
  },
);

/** Fetch one document and store it; the caller holds the key's lock. */
async function importOne(args: {
  request: Request;
  client: SourceClient;
  userId: string;
  system: DocumentPickerSystem;
  instance: string;
  sourceId: string;
  kind: InboundDocumentKindValue | null;
  link: LinkTarget | undefined;
}): Promise<Response> {
  const { request, client, userId, system, instance, sourceId, kind, link } =
    args;
  const limits = await resolveDocumentLimits(userId);
  let meta;
  let file;
  try {
    meta = await client.document(sourceId);
    file = await client.download(sourceId, limits.maxFileBytes);
  } catch (err) {
    return responseForSourceFailure(err);
  }

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

  const result = await ingestDocument({
    userId,
    scoped: false,
    ipAddress: getClientIp(request),
    bytes: Buffer.from(file.bytes),
    filename: meta.filename ?? file.filename,
    title: meta.title,
    kind,
    documentDate: meta.date,
    episodeIds: [],
    encounterIds: [],
    sourceSystem: system,
    sourceId,
    sourceInstance: instance,
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
}
