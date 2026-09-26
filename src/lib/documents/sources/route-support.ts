/**
 * What every document-source route does before its own work, and how a source
 * failure becomes a response.
 *
 * The admission rule, with {@link admitDocumentSourceCaller} as its second
 * half:
 *
 *   - the route's own `requireAuth()` with no scope: a session, or a `["*"]` token; a narrow
 *     token is refused, and so is any request acting on somebody else's record
 *     (403 `sharing.not_permitted`). A delegate, whatever their grant, and a
 *     guardian acting for a managed record never reach a connection: it is the
 *     owner's credential to a system outside HealthLog, and driving it would
 *     read the owner's whole archive there, which no grant covers;
 *   - then the transport must be the cookie. A `["*"]` Bearer (the native
 *     client, a script holding a login token) is refused: the picker is a
 *     browser surface, and a credential for another system is managed only
 *     from one;
 *   - the documents module must be on, and the operator must have listed at
 *     least one origin in `DOCUMENT_SOURCE_ORIGINS`. Without the list the
 *     routes answer 404 before reading a row.
 */
import type { AuthContext } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";

import { DocumentSourceError, DocumentSourceTooLargeError } from "./http";
import { documentSourcesAvailable } from "./origins";
import {
  documentSourceErrorCode,
  systemFromSlug,
  type DocumentPickerSystem,
  type DocumentSourceErrorCode,
} from "./types";

/**
 * Admit a caller the route has already resolved with a bare `requireAuth()`.
 *
 * Each route calls `requireAuth()` itself, in its own module, so the sharing
 * guard's scan sees every one of them as a bare, owner-only route rather than
 * a helper it cannot follow. This adds the rest: a cookie transport, the
 * documents module and the operator's list. The status read and the delete
 * pass `needsList: false, needsModule: false`: they touch only the person's
 * own row and never the network.
 */
export async function admitDocumentSourceCaller(
  auth: AuthContext,
  options: { needsList?: boolean; needsModule?: boolean } = {},
): Promise<Response | null> {
  if (auth.authMethod !== "cookie") {
    return apiError(
      "Document archives are managed from a browser session.",
      403,
      { errorCode: "documents.sources.browserOnly" },
    );
  }
  // Reading and removing one's own connection needs neither the module nor
  // the list: a person who switched Documents off, or whose operator removed
  // the list, must still be able to see and delete the stored token.
  if (options.needsModule !== false) {
    const gate = await requireModuleEnabled(auth.user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;
  }
  if (options.needsList !== false && !documentSourcesAvailable()) {
    return sourceErrorResponse("unavailable");
  }
  return null;
}

/** The `{system}` path segment, or a 404 for anything else. */
export async function systemParam(
  params: Promise<{ system: string }>,
): Promise<DocumentPickerSystem | Response> {
  const { system } = await params;
  const resolved = systemFromSlug(system);
  return resolved ?? apiError("Unknown document system.", 404);
}

const STATUS: Record<DocumentSourceErrorCode, number> = {
  unavailable: 404,
  notConnected: 404,
  originNotAllowed: 422,
  unreachable: 502,
  redirected: 502,
  authRefused: 502,
  versionTooOld: 502,
  badResponse: 502,
  notFound: 404,
  linkTargetNotFound: 404,
  rateLimited: 429,
};

const MESSAGE: Record<DocumentSourceErrorCode, string> = {
  unavailable: "Document archives are not enabled on this server.",
  notConnected: "This document archive is not connected.",
  originNotAllowed:
    "This address is not on the server's list of allowed document archives.",
  unreachable: "The document archive could not be reached.",
  redirected:
    "The document archive redirected the request. Use the address it redirects to.",
  authRefused: "The document archive refused the API token.",
  versionTooOld: "The document archive's version is too old.",
  badResponse: "The document archive gave an answer HealthLog cannot read.",
  notFound: "The document archive has no such document or organization.",
  linkTargetNotFound: "The record to link to was not found.",
  rateLimited: "Too many requests. Try again later.",
};

export function sourceErrorResponse(
  code: DocumentSourceErrorCode,
  upstreamStatus?: number,
  headers?: Record<string, string>,
): Response {
  return apiError(MESSAGE[code], STATUS[code], {
    errorCode: documentSourceErrorCode(code),
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
    ...(headers ? { headers } : {}),
  });
}

/** Map a thrown source failure to its response; rethrow anything else. */
export function responseForSourceFailure(err: unknown): Response {
  if (err instanceof DocumentSourceError) {
    return sourceErrorResponse(err.code, err.upstreamStatus);
  }
  if (err instanceof DocumentSourceTooLargeError) {
    return apiError("File is too large.", 413, {
      errorCode: "documents.inbound.fileTooLarge",
      reason: "fileTooLarge",
      maxFileBytes: err.maxFileBytes,
    });
  }
  throw err;
}

/** Saves and tests share one allowance: each one dials the source. */
const CONNECT_LIMIT_PER_MINUTE = 10;

export function checkConnectRateLimit(
  userId: string,
): Promise<RateLimitResult> {
  return checkRateLimit(
    `documents-source-connect:${userId}`,
    CONNECT_LIMIT_PER_MINUTE,
    60_000,
  );
}

/**
 * Searches and tag reads per minute. Each one is a request to the source; a
 * debounced search field sends one per pause in typing, which this leaves
 * ample room for.
 */
const SEARCH_LIMIT_PER_MINUTE = 60;

export function checkSearchRateLimit(userId: string): Promise<RateLimitResult> {
  return checkRateLimit(
    `documents-source-search:${userId}`,
    SEARCH_LIMIT_PER_MINUTE,
    60_000,
  );
}
