/**
 * Document vault: store-first upload + browsable list.
 *
 * POST is STORE-ONLY and provider-free. A self-hoster uploads any accepted
 * document; it is stored ENCRYPTED at rest (binary codec) with
 * `status: STORED` and NO extraction run. There is no provider resolution, no
 * AI consent guard, no budget, and NO egress on this path — a file can always
 * be filed, even on an account with no document-scan provider configured.
 *
 * The upload path enforces the vault policy layer
 * (`src/lib/documents/upload-policy.ts`): magic-byte classification (the wire
 * Content-Type is never trusted), the admin-tunable per-file cap (bounded
 * read aborts at the cap), the per-user quota (checked in the same
 * transaction as the insert, tombstone-inclusive), sha256 duplicate detection
 * (a same-user re-upload returns the existing live row, never a second copy),
 * an honoured `Idempotency-Key`, and optional `episodeIds[]` pre-linking.
 *
 * v1.39.2 (#1038) — POST also admits a narrow `documents:write` token, the
 * door another document system (a Paperless workflow, the import script)
 * pushes through. Such a caller gets its own rate bucket, and a receipt
 * (`{ id, duplicate }`) instead of the stored row: a credential that can only
 * add files learns that a file exists, never how its owner filed it. Optional
 * `sourceSystem` / `sourceId` fields key an import so a re-send is a
 * duplicate, including after the person deleted the document; `aiRead=defer`
 * holds back automatic AI reading for the upload.
 *
 * GET lists the caller's documents with title/filename search, kind /
 * episode / year / date-range filters, sort, and keyset pagination — and
 * NEVER selects the encrypted blob column (`omit: { contentEncrypted: true }`).
 *
 * The document is UNTRUSTED (prompt-injection): the server never acts on an
 * instruction inside it. Storing it does nothing with its contents.
 */
import { Buffer } from "node:buffer";

import { NextResponse } from "next/server";

import {
  apiHandler,
  isScopedCredential,
  requireAuth,
  requireRecordAuth,
  type AuthContext,
} from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  getClientIp,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { getAiCapability } from "@/lib/ai/capabilities/gate";
import { prisma } from "@/lib/db";
import { hashQueryTokens } from "@/lib/documents/content-index";
import {
  ingestDocument,
  isoDateToUtc,
  personalUploadBucket,
  UPLOAD_LIMIT_PER_HOUR,
  UPLOAD_WINDOW_MS,
} from "@/lib/documents/ingest";
import {
  loadConditionLinks,
  loadDocumentEncounterLinks,
} from "@/lib/documents/links";
import {
  serialiseDocument,
  type SerialisableDocument,
} from "@/lib/documents/store";
import { DOCUMENTS_WRITE_SCOPE } from "@/lib/documents/scopes";
import {
  checkSourceLookupRateLimit,
  findSourceKey,
  type SourceKeyMatch,
} from "@/lib/documents/source-key";
import {
  acquireDocumentUploadSlot,
  resolveDocumentLimits,
  resolveDocumentUploadLimitPerHour,
} from "@/lib/documents/upload-policy";
import { withIdempotency } from "@/lib/idempotency";
import { BodyTooLargeError, readBoundedBody } from "@/lib/labs/ocr-upload";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  documentCreateSchema,
  documentListQuerySchema,
  documentSourceKeySchema,
  toContentIndexSource,
  type DocumentSourceSystemValue,
} from "@/lib/validations/inbound-documents";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/**
 * Multipart envelope allowance on top of the per-file cap: boundaries plus
 * the small metadata fields (title / kind / documentDate / episodeIds). The
 * exact per-file cap is re-enforced on the extracted file bytes below.
 */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const UPLOAD_BODY_TIMEOUT_MS = 30_000;

/** §3.2 — 413 fileTooLarge with the configured limit in `meta`. */
function fileTooLarge(maxFileBytes: number): NextResponse {
  return apiError("File is too large.", 413, {
    errorCode: "documents.inbound.fileTooLarge",
    reason: "fileTooLarge",
    maxFileBytes,
  });
}

/** What a single upload asked for, carried into the annotations. */
interface UploadContext {
  userId: string;
  /** A narrow `documents:write` token, not a session or a `["*"]` token. */
  scoped: boolean;
  sourceSystem: DocumentSourceSystemValue | null;
  aiDeferred: boolean;
}

/**
 * The receipt a scoped caller gets in place of the stored row: the id and
 * whether the upload was a duplicate. A write-only credential holder who
 * knows a file's bytes learns that it is stored, not its title, filename,
 * links or fact counts.
 */
function receiptResponse(
  id: string | null,
  status: 200 | 201,
  flags: { duplicate: boolean; deleted?: boolean },
): NextResponse {
  const data = {
    id,
    duplicate: flags.duplicate,
    ...(flags.deleted ? { deleted: true } : {}),
  };
  return NextResponse.json(
    {
      data,
      error: null,
      ...(flags.duplicate
        ? {
            meta: {
              duplicate: true,
              ...(flags.deleted ? { deleted: true } : {}),
            },
          }
        : {}),
    },
    { status },
  );
}

/**
 * v1.39.2 (#1038) — a re-send of an imported document the person deleted.
 * 200 and no new row, for every caller: the deletion was a decision, and an
 * importer re-running over the same source must not undo it. `id` is the
 * tombstoned row while it exists and null once the purge took it; there is no
 * row left to serialise either way, so the answer is the receipt.
 */
function deletedResponse(ctx: UploadContext, id: string | null): NextResponse {
  annotate({
    action: { name: "documents.vault.upload" },
    meta: {
      documentId: id,
      duplicate: true,
      deleted: true,
      scoped: ctx.scoped,
      sourceSystem: ctx.sourceSystem,
      aiDeferred: ctx.aiDeferred,
    },
  });
  return receiptResponse(id, 200, { duplicate: true, deleted: true });
}

/**
 * The same bytes have already been sent under too many source keys
 * (`MAX_SOURCE_ALIASES_PER_DOCUMENT`). A conflict with what is stored, not a
 * rate: nothing is remembered and nothing stored.
 */
function aliasLimitResponse(): NextResponse {
  return apiError(
    "This file is already stored under too many source ids.",
    409,
    { errorCode: "documents.inbound.sourceAliasLimit" },
  );
}

/** Answer a source key that is already held: duplicate, or deleted. */
function answerSourceKey(
  ctx: UploadContext,
  match: SourceKeyMatch,
): Promise<NextResponse> | NextResponse {
  return match.state === "live"
    ? duplicateResponse(ctx, match.document)
    : deletedResponse(ctx, match.id);
}

/**
 * §3.2 — a duplicate upload is NOT an error: return the existing live row
 * with `meta.duplicate: true` at the envelope level (the UI toasts "already
 * stored" and highlights the row). A scoped caller gets the receipt instead.
 */
async function duplicateResponse(
  ctx: UploadContext,
  existing: SerialisableDocument,
): Promise<NextResponse> {
  annotate({
    action: { name: "documents.vault.upload" },
    meta: {
      documentId: existing.id,
      duplicate: true,
      scoped: ctx.scoped,
      sourceSystem: ctx.sourceSystem,
      aiDeferred: ctx.aiDeferred,
    },
  });
  if (ctx.scoped) {
    return receiptResponse(existing.id, 200, { duplicate: true });
  }
  const userId = ctx.userId;
  const [links, visitLinks, groups] = await Promise.all([
    loadConditionLinks(userId, [existing.id]),
    loadDocumentEncounterLinks(userId, [existing.id]),
    prisma.extractedFact.groupBy({
      by: ["status"],
      where: { userId, documentId: existing.id },
      _count: { _all: true },
    }),
  ]);
  let factCount = 0;
  let pendingCount = 0;
  for (const g of groups) {
    if (g.status !== "REJECTED") factCount += g._count._all;
    if (g.status === "PENDING") pendingCount += g._count._all;
  }
  return NextResponse.json(
    {
      data: serialiseDocument(
        existing,
        { factCount, pendingCount },
        links.get(existing.id) ?? [],
        false,
        null,
        false,
        visitLinks.get(existing.id) ?? [],
      ),
      error: null,
      meta: { duplicate: true },
    },
    { status: 200 },
  );
}

/** Process one admitted upload. The caller owns and releases its memory slot. */
async function processUpload(
  request: Request,
  auth: AuthContext,
): Promise<Response> {
  const { user } = auth;
  const scoped = isScopedCredential(auth);

  // Opt-in module gate — even a valid Bearer token is refused when the surface
  // is off (it ships dark; the user turns it on deliberately).
  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  // A source key may ride the query string. It is answered here, before the
  // bucket is charged and before a byte of the body is read: a nightly
  // re-sync of an archive HealthLog already holds costs neither. Both halves
  // or neither; half a key is a mistake worth saying so about.
  const url = new URL(request.url);
  const querySystem = url.searchParams.get("sourceSystem");
  const queryId = url.searchParams.get("sourceId");
  let queryKey: {
    sourceSystem: DocumentSourceSystemValue;
    sourceId: string;
  } | null = null;
  if (querySystem !== null || queryId !== null) {
    const parsedKey = documentSourceKeySchema.safeParse({
      sourceSystem: querySystem ?? undefined,
      sourceId: queryId ?? undefined,
    });
    if (!parsedKey.success) {
      return apiValidationError(
        "Invalid source key",
        sanitiseZodIssues(parsedKey.error.issues),
        422,
        { errorCode: "documents.inbound.invalidMetadata" },
      );
    }
    queryKey = parsedKey.data;
    // Metered like the lookup route, on the same bucket: the check stores
    // nothing and costs no upload slot, but it is not a free oracle either.
    const lookupRl = await checkSourceLookupRateLimit(
      scoped,
      auth.session.id,
      user.id,
    );
    if (!lookupRl.allowed) {
      const response = apiError("Too many lookups. Try again later.", 429, {
        errorCode: "documents.inbound.rateLimited",
      });
      for (const [k, v] of Object.entries(rateLimitHeaders(lookupRl))) {
        response.headers.set(k, v);
      }
      return response;
    }
    const match = await findSourceKey(
      user.id,
      queryKey.sourceSystem,
      queryKey.sourceId,
    );
    if (match) {
      return answerSourceKey(
        {
          userId: user.id,
          scoped,
          sourceSystem: queryKey.sourceSystem,
          aiDeferred: false,
        },
        match,
      );
    }
  }

  // A scoped token draws on its own bucket, keyed on the token (its id rides
  // `session.id` on the Bearer path), so an import running overnight cannot
  // use up the allowance the person's own uploads from the web or the phone
  // draw on. The cookie / wildcard bucket is unchanged.
  const bucketKey = scoped
    ? `documents-upload:token:${auth.session.id}`
    : personalUploadBucket(user.id);
  const rl = await checkRateLimit(
    bucketKey,
    scoped ? resolveDocumentUploadLimitPerHour() : UPLOAD_LIMIT_PER_HOUR,
    UPLOAD_WINDOW_MS,
  );
  // Every upload that reaches the body pays its slot, stored or not. The cheap
  // way to re-send is the query-string key above, answered before this line;
  // handing slots back after a full body read would let a leaked token send
  // the same bytes under id after id for free.
  if (!rl.allowed) {
    const response = apiError("Too many uploads. Try again later.", 429, {
      errorCode: "documents.inbound.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const limits = await resolveDocumentLimits(user.id);
  const bodyCap = limits.maxFileBytes + MULTIPART_OVERHEAD_BYTES;

  // Instant rejection on a declared oversize (a CD/ISO-sized upload never
  // allocates); the bounded read below covers chunked/undeclared bodies.
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > bodyCap) {
    return fileTooLarge(limits.maxFileBytes);
  }

  let formData: FormData;
  try {
    const bytes = await readBoundedBody(request.body, bodyCap, {
      signal: request.signal,
      deadline: Date.now() + UPLOAD_BODY_TIMEOUT_MS,
    });
    formData = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      body: bytes,
    }).formData();
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return fileTooLarge(limits.maxFileBytes);
    }
    if (err instanceof DOMException && err.name === "AbortError") {
      return apiError("Upload body read timed out.", 408, {
        errorCode: "documents.inbound.uploadTimeout",
        reason: "uploadTimeout",
      });
    }
    return apiError("Invalid multipart body", 400);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return apiError("Field 'file' must be a file", 422);
  }

  // Optional metadata (title / kind / documentDate / episodeIds /
  // encounterIds). The file is read separately; these are the form fields
  // beside it. Both id lists may be repeated.
  const rawEpisodeIds = formData
    .getAll("episodeIds")
    .filter((v): v is string => typeof v === "string");
  const rawEncounterIds = formData
    .getAll("encounterIds")
    .filter((v): v is string => typeof v === "string");
  const parsed = documentCreateSchema.safeParse({
    title: formData.get("title") ?? undefined,
    kind: formData.get("kind") ?? undefined,
    documentDate: formData.get("documentDate") ?? undefined,
    episodeIds: rawEpisodeIds.length > 0 ? rawEpisodeIds : undefined,
    encounterIds: rawEncounterIds.length > 0 ? rawEncounterIds : undefined,
    sourceSystem: formData.get("sourceSystem") ?? undefined,
    sourceId: formData.get("sourceId") ?? undefined,
    aiRead: formData.get("aiRead") ?? undefined,
  });
  if (!parsed.success) {
    return apiValidationError(
      "Invalid document metadata",
      sanitiseZodIssues(parsed.error.issues),
      422,
      {
        errorCode: "documents.inbound.invalidMetadata",
      },
    );
  }

  // The key from the query string, or from the form fields; if a caller sends
  // both they have to agree.
  const formSystem = parsed.data.sourceSystem ?? null;
  const formId = formSystem ? (parsed.data.sourceId ?? null) : null;
  if (
    queryKey &&
    formSystem !== null &&
    (formSystem !== queryKey.sourceSystem || formId !== queryKey.sourceId)
  ) {
    return apiError(
      "The source key in the address and in the form differ.",
      422,
      { errorCode: "documents.inbound.invalidMetadata" },
    );
  }
  const sourceSystem = queryKey?.sourceSystem ?? formSystem;
  const sourceId = queryKey?.sourceId ?? formId;
  const ctx: UploadContext = {
    userId: user.id,
    scoped,
    sourceSystem,
    aiDeferred: parsed.data.aiRead === "defer",
  };

  // A source key answers before the bytes are looked at: an import re-sending
  // what it sent before is a duplicate, and one re-sending a document the
  // person deleted is refused a second copy — live and tombstoned rows both
  // count (the unique index has no `deleted_at` predicate), and past the purge
  // the ledger remembers.
  if (sourceSystem && sourceId && !queryKey) {
    const match = await findSourceKey(user.id, sourceSystem, sourceId);
    if (match) return answerSourceKey(ctx, match);
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return apiError("Failed to read uploaded file", 400);
  }

  // Everything from here to the stored row is the shared ingest path
  // (`src/lib/documents/ingest.ts`), the one the document picker's import
  // stores through as well.
  const result = await ingestDocument({
    userId: user.id,
    scoped,
    ipAddress: getClientIp(request),
    bytes: buffer,
    filename: typeof file.name === "string" ? file.name : null,
    title: parsed.data.title ?? null,
    kind: parsed.data.kind ?? null,
    documentDate: parsed.data.documentDate ?? null,
    episodeIds: parsed.data.episodeIds ?? [],
    encounterIds: parsed.data.encounterIds ?? [],
    sourceSystem,
    sourceId,
    aiDeferred: ctx.aiDeferred,
    sourceKeyChecked: true,
    limits,
    // Only the AI work queued after a fresh insert follows the capability;
    // the upload itself is data and always accepted.
    documentAi: () => getAiCapability("documentAi"),
  });

  switch (result.kind) {
    case "sourceKey":
      return answerSourceKey(ctx, result.match);
    case "tooLarge":
      return fileTooLarge(result.maxFileBytes);
    case "empty":
      return apiError("Uploaded file is empty", 422, {
        errorCode: "documents.inbound.invalidMetadata",
      });
    case "unsupportedType":
      return apiError("This file type is not supported.", 415, {
        errorCode: "documents.inbound.fileType",
        reason: "unsupportedType",
      });
    case "episodeNotFound":
      return apiError("Episode not found", 404, {
        errorCode: "documents.inbound.episodeNotFound",
      });
    case "encounterNotFound":
      return apiError("Visit not found", 404, {
        errorCode: "documents.inbound.encounterNotFound",
      });
    case "aliasLimit":
      return aliasLimitResponse();
    case "duplicate":
      return duplicateResponse(ctx, result.document);
    case "quotaExceeded":
      // The figures are the owner's; a write-only token learns only that the
      // vault is full.
      return apiError("Storage quota exceeded.", 413, {
        errorCode: "documents.inbound.quotaExceeded",
        reason: "quotaExceeded",
        ...(scoped
          ? {}
          : { quotaBytes: result.quotaBytes, usedBytes: result.usedBytes }),
      });
    case "stored":
      break;
  }

  const document = result.document;
  if (scoped) return receiptResponse(document.id, 201, { duplicate: false });

  const [links, visitLinks] = await Promise.all([
    loadConditionLinks(user.id, [document.id]),
    loadDocumentEncounterLinks(user.id, [document.id]),
  ]);
  return apiSuccess(
    serialiseDocument(
      document,
      { factCount: 0, pendingCount: 0 },
      links.get(document.id) ?? [],
      false,
      null,
      false,
      visitLinks.get(document.id) ?? [],
    ),
    201,
  );
}

/** Authenticate and reserve memory capacity before any request-body read. */
async function postUpload(request: Request): Promise<Response> {
  // One of the two routes that name `documents:write` (the other is the
  // source-key lookup beside it). Every other vault leg —
  // list, detail, original, thumbnail, bulk, AI — declares no scope and so
  // refuses the token (`bearer-scope-enforcement-guard.test.ts`).
  const auth = await requireAuth(DOCUMENTS_WRITE_SCOPE);
  const { user } = auth;
  const releaseUploadSlot = acquireDocumentUploadSlot(user.id);
  if (!releaseUploadSlot) {
    const response = apiError(
      "Too many uploads are already in progress. Try again shortly.",
      429,
      {
        errorCode: "documents.inbound.uploadBusy",
        reason: "uploadBusy",
      },
    );
    response.headers.set("Retry-After", "1");
    return response;
  }

  try {
    return await processUpload(request, auth);
  } finally {
    releaseUploadSlot();
  }
}

export const POST = apiHandler(withIdempotency<[Request]>(postUpload));

/**
 * GET — list the record's documents (search / filter / sort / paginate).
 *
 * v1.36.x — delegable. `/documents` carries `sharedRecord: true` in the nav
 * model, so the shell offers the destination under a switch and every read
 * behind it refused: the vault rendered a query-error card, and the illness
 * page's episode-documents tile rendered another one beside it. A clinical
 * letter is health data belonging to the record, and reading it is the whole
 * point of handing somebody the record.
 *
 * The POST above is NOT delegable and declares its own scope. Uploading is not
 * a verb the grant admits, and the module-level split matters here: the
 * resolver escalates any non-safe method to `"write"`, so the two arms have to
 * declare separately rather than share one line.
 */
export const GET = apiHandler(async (request: Request) => {
  const { user } = await requireRecordAuth("read", "documents");

  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const url = new URL(request.url);
  // `kind` is a multi-value facet: repeated params and/or comma-separated.
  const kinds = url.searchParams
    .getAll("kind")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const single = Object.fromEntries(url.searchParams);
  const parsed = documentListQuerySchema.safeParse({
    ...single,
    kind: kinds.length > 0 ? kinds : undefined,
  });
  if (!parsed.success) {
    return apiValidationError(
      "Invalid list query",
      sanitiseZodIssues(parsed.error.issues),
      422,
      {
        errorCode: "documents.inbound.invalidQuery",
      },
    );
  }
  const {
    q,
    kind,
    episodeId,
    encounterId,
    year,
    from,
    to,
    sort,
    order,
    cursor,
    limit,
  } = parsed.data;

  const where: Prisma.InboundDocumentWhereInput = {
    userId: user.id,
    deletedAt: null,
  };
  if (kind && kind.length > 0) where.kind = { in: kind };
  if (episodeId) where.conditionLinks = { some: { episodeId } };
  // The visit filter reads the SAME table the visit's own sheet writes, from
  // the document side. Filtering rather than post-filtering: a page of fifty
  // documents narrowed in Node would page wrongly.
  if (encounterId) where.encounterLinks = { some: { encounterId } };
  if (year !== undefined) {
    where.documentDate = {
      gte: new Date(Date.UTC(year, 0, 1)),
      lt: new Date(Date.UTC(year + 1, 0, 1)),
    };
  } else if (from || to) {
    where.documentDate = {
      ...(from ? { gte: isoDateToUtc(from) } : {}),
      // inclusive end-of-day for the `to` bound
      ...(to ? { lt: new Date(isoDateToUtc(to).getTime() + 86_400_000) } : {}),
    };
  }
  if (q) {
    // Substring match on the short plaintext fields …
    const or: Prisma.InboundDocumentWhereInput[] = [
      { title: { contains: q, mode: "insensitive" } },
      { filename: { contains: q, mode: "insensitive" } },
    ];
    // … unioned with a WHOLE-WORD content match over the blind token index.
    // The query is tokenised + HMAC'd the same way the index was built, then
    // matched with a GIN-accelerated array-overlap (`hasSome` → `&&`). The
    // list still never selects the encrypted text — only the opaque hashes are
    // touched, in the related table. Degrades silently to title/filename when
    // the caller has no indexed documents (no rows overlap).
    const hashes = hashQueryTokens(q);
    if (hashes.length > 0) {
      or.push({ contentIndex: { is: { searchTokens: { hasSome: hashes } } } });
    }
    where.OR = or;
  }

  // Keyset pagination on the sort column + a stable `id` tiebreak; nullable
  // sort columns sort nulls last so undated documents trail.
  const primaryOrder:
    Prisma.InboundDocumentOrderByWithRelationInput | undefined =
    sort === "documentDate"
      ? { documentDate: { sort: order, nulls: "last" } }
      : sort === "title"
        ? { title: { sort: order, nulls: "last" } }
        : { createdAt: order };
  const orderBy: Prisma.InboundDocumentOrderByWithRelationInput[] = [
    primaryOrder,
    { id: order },
  ];

  // Hardening: the list NEVER fetches the encrypted blob column — a page of
  // 50 rows would otherwise drag up to 50 × cap ciphertext bytes per request.
  const rows = await prisma.inboundDocument.findMany({
    where,
    omit: { contentEncrypted: true },
    orderBy,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  // Fact tallies for the whole page in ONE grouped count — no per-document
  // fan-out and no materialising fact-id rows. `factCount` counts every
  // non-REJECTED fact (a rejected fact is discarded, not part of the
  // document's tally), `pendingCount` the PENDING subset awaiting review.
  const factCounts = new Map<
    string,
    { factCount: number; pendingCount: number }
  >();
  if (page.length > 0) {
    const groups = await prisma.extractedFact.groupBy({
      by: ["documentId", "status"],
      where: { userId: user.id, documentId: { in: page.map((d) => d.id) } },
      _count: { _all: true },
    });
    for (const g of groups) {
      const entry = factCounts.get(g.documentId) ?? {
        factCount: 0,
        pendingCount: 0,
      };
      const n = g._count._all;
      if (g.status !== "REJECTED") entry.factCount += n;
      if (g.status === "PENDING") entry.pendingCount += n;
      factCounts.set(g.documentId, entry);
    }
  }

  // Condition/visit links + the content-index and thumbnail probes for the
  // page, all in ONE Promise.all — four independent grouped queries (no
  // N+1, never a ciphertext/blob column), and the vault polls this list
  // every few seconds so two serialized round-trips were pure added
  // latency (A5-4).
  const pageIds = page.map((d) => d.id);
  const [linkMap, visitLinkMap, indexedRows, thumbRows] = await Promise.all([
    loadConditionLinks(user.id, pageIds),
    loadDocumentEncounterLinks(user.id, pageIds),
    // Which of the page's documents have a content index (drives the
    // searchable status + the provenance the UI reads to tell an AI-read
    // document from a locally-indexed one).
    page.length > 0
      ? prisma.documentContentIndex.findMany({
          where: { userId: user.id, documentId: { in: pageIds } },
          select: { documentId: true, source: true },
        })
      : Promise.resolve([]),
    // Which of the page's documents have a preview thumbnail (gates the
    // card's <img>). Grouped on the 1:1 side table.
    page.length > 0
      ? prisma.documentThumbnail.findMany({
          where: { userId: user.id, documentId: { in: pageIds } },
          select: { documentId: true },
        })
      : Promise.resolve([]),
  ]);
  const indexSources = new Map<string, string>();
  for (const row of indexedRows) indexSources.set(row.documentId, row.source);
  const thumbnailIds = new Set<string>();
  for (const row of thumbRows) thumbnailIds.add(row.documentId);

  annotate({
    action: { name: "documents.inbound.list" },
    meta: {
      count: page.length,
      sort,
      order,
      filtered: Boolean(
        q || (kind && kind.length > 0) || episodeId || encounterId || year,
      ),
    },
  });

  return apiSuccess({
    documents: page.map((doc) =>
      serialiseDocument(
        doc,
        factCounts.get(doc.id) ?? { factCount: 0, pendingCount: 0 },
        linkMap.get(doc.id) ?? [],
        indexSources.has(doc.id),
        toContentIndexSource(indexSources.get(doc.id)),
        thumbnailIds.has(doc.id),
        visitLinkMap.get(doc.id) ?? [],
      ),
    ),
    nextCursor,
  });
});
