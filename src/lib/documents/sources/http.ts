/**
 * The document picker's one way to the network.
 *
 * Every request to a Paperless-ngx or Papra instance goes through
 * {@link sourceRequest}, which goes through `safeFetch` with the connection's
 * origin as `operatorApprovedPrivateOrigin`:
 *
 *   - the target must have exactly that origin (a path, query or `next` link
 *     that names another host is refused before a socket opens);
 *   - redirects are never followed; a 3xx is reported as `redirected`, so a
 *     source cannot bounce the request and its `Authorization` header to
 *     another host;
 *   - the connect goes through the pinned operator-approved dispatcher, which
 *     refuses link-local, metadata and unspecified addresses at dial time even
 *     for a listed name;
 *   - every call has a timeout, and every body is read with a byte cap.
 *
 * The origin handed in is the one the caller just re-checked against
 * `DOCUMENT_SOURCE_ORIGINS`. Nothing here decides trust; it only refuses to
 * go anywhere else.
 */
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";
import { BodyTooLargeError, readBoundedBody } from "@/lib/labs/ocr-upload";
import { annotate } from "@/lib/logging/context";

import type { DocumentSourceErrorCode } from "./types";

/** JSON bodies larger than this are not a search page; refuse them. */
export const SOURCE_JSON_MAX_BYTES = 1024 * 1024;
export const SOURCE_JSON_TIMEOUT_MS = 10_000;
export const SOURCE_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * A request to a source ended somewhere other than a usable answer. The code
 * is what the client translates; `upstreamStatus` is the only thing about the
 * source's answer that is passed on. Its body never is: an error page can
 * echo the request's credentials or internal paths.
 */
export class DocumentSourceError extends Error {
  readonly code: DocumentSourceErrorCode;
  readonly upstreamStatus?: number;

  constructor(code: DocumentSourceErrorCode, upstreamStatus?: number) {
    super(`document source: ${code}`);
    this.name = "DocumentSourceError";
    this.code = code;
    if (upstreamStatus !== undefined) this.upstreamStatus = upstreamStatus;
  }
}

/** The document is larger than the vault accepts; carries the cap. */
export class DocumentSourceTooLargeError extends Error {
  constructor(readonly maxFileBytes: number) {
    super("document source: file larger than the vault accepts");
    this.name = "DocumentSourceTooLargeError";
  }
}

export interface SourceTarget {
  /** The listed origin, exactly as `DOCUMENT_SOURCE_ORIGINS` holds it. */
  origin: string;
  /** Origin plus the optional base path, no trailing slash. */
  baseUrl: string;
  headers: Record<string, string>;
}

async function sourceRequest(
  target: SourceTarget,
  path: string,
  timeoutMs: number,
): Promise<Response> {
  const url = `${target.baseUrl}${path}`;
  let response: Response;
  try {
    response = await safeFetch(
      url,
      { method: "GET", headers: target.headers, redirect: "manual" },
      { operatorApprovedPrivateOrigin: target.origin, timeoutMs },
    );
  } catch (err) {
    // A refused destination, a timeout and a dead host all read the same to
    // the person: the source could not be reached from here. The operator's
    // wide event keeps the kind.
    annotate({
      meta: {
        sourceFailure: err instanceof SafeFetchError ? err.kind : "network",
      },
    });
    throw new DocumentSourceError("unreachable");
  }
  if (response.status >= 300 && response.status < 400) {
    await discard(response);
    throw new DocumentSourceError("redirected", response.status);
  }
  return response;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // nothing to release
  }
}

/** Map a non-2xx answer to the error the person sees. */
export async function failFor(
  response: Response,
  notFound: DocumentSourceErrorCode = "notFound",
): Promise<never> {
  await discard(response);
  const status = response.status;
  if (status === 401 || status === 403) {
    throw new DocumentSourceError("authRefused", status);
  }
  if (status === 404) throw new DocumentSourceError(notFound, status);
  // Paperless-ngx answers 406 to an API version it no longer (or not yet)
  // speaks.
  if (status === 406) throw new DocumentSourceError("versionTooOld", status);
  throw new DocumentSourceError("badResponse", status);
}

/** GET a JSON document, bounded in time and size. */
export async function sourceJson(
  target: SourceTarget,
  path: string,
  options: { notFound?: DocumentSourceErrorCode } = {},
): Promise<{ body: unknown; response: Response }> {
  const response = await sourceRequest(target, path, SOURCE_JSON_TIMEOUT_MS);
  if (!response.ok) return failFor(response, options.notFound);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > SOURCE_JSON_MAX_BYTES) {
    await discard(response);
    throw new DocumentSourceError("badResponse", response.status);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(response.body, SOURCE_JSON_MAX_BYTES);
  } catch {
    throw new DocumentSourceError("badResponse", response.status);
  }
  try {
    return {
      body: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      response,
    };
  } catch {
    // A login page or a proxy's HTML error instead of the API: most often a
    // base address that points at the web app rather than its API root.
    throw new DocumentSourceError("badResponse", response.status);
  }
}

/** GET a file, bounded by the vault's own per-file cap. */
export async function sourceDownload(
  target: SourceTarget,
  path: string,
  maxFileBytes: number,
): Promise<{ bytes: Uint8Array; filename: string | null }> {
  const response = await sourceRequest(
    target,
    path,
    SOURCE_DOWNLOAD_TIMEOUT_MS,
  );
  if (!response.ok) return failFor(response);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxFileBytes) {
    await discard(response);
    throw new DocumentSourceTooLargeError(maxFileBytes);
  }
  try {
    const bytes = await readBoundedBody(response.body, maxFileBytes);
    return {
      bytes,
      filename: filenameFrom(response.headers.get("content-disposition")),
    };
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      throw new DocumentSourceTooLargeError(maxFileBytes);
    }
    throw new DocumentSourceError("unreachable");
  }
}

/** The file name a download names, if it names one. */
export function filenameFrom(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : null;
}
