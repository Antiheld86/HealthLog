/**
 * The two source adapters the document picker speaks: Paperless-ngx and Papra.
 *
 * Each turns the picker's four questions (does this connection work, which
 * tags exist, which documents match, give me this one) into the source's own
 * REST calls, and each answer into the picker's minimal shapes. Everything
 * leaves through `./http.ts`, so the origin pin, the redirect refusal, the
 * timeouts and the byte caps are not something an adapter can forget.
 *
 * Both adapters re-check tag and date filters on what comes back. A server
 * that ignores a parameter (an older Paperless, a Papra whose search syntax
 * changed) must not widen a result into documents the person filtered out;
 * the import script makes the same check for the same reason.
 *
 * API versions: Paperless-ngx is asked for API version 9 (Paperless-ngx 2.16
 * and later, the version where `created` became a plain date; it answers 406
 * to a version it does not speak). Papra's endpoints are the documented
 * organization-scoped ones (`/api/organizations/{id}/documents`, `/tags`,
 * `/documents/{id}`, `/documents/{id}/file`).
 */
import { DOCUMENT_TITLE_MAX } from "@/lib/validations/inbound-documents";

import {
  DocumentSourceError,
  sourceDownload,
  sourceJson,
  type SourceTarget,
} from "./http";
import {
  DOCUMENT_PICKER_MAX_TAGS,
  DOCUMENT_PICKER_PAGE_SIZE,
  isSourceDocumentId,
  PAPRA_ORG_ID,
  type DocumentPickerSystem,
  type DocumentSourceErrorCode,
  type DocumentSourceTagDto,
} from "./types";

/** Paperless-ngx API version the picker speaks (Paperless-ngx 2.16+). */
export const PAPERLESS_API_VERSION = 9;

export interface SourceSearchParams {
  /** Name to search for; empty lists everything. */
  q: string;
  /** A tag id as the source names it. */
  tagId: string | null;
  /** YYYY-MM-DD, inclusive. */
  from: string | null;
  to: string | null;
  /** 1-based. */
  page: number;
}

export interface SourceListItem {
  sourceId: string;
  title: string;
  date: string | null;
  tags: string[];
  sizeBytes: number | null;
}

export interface SourceDocumentMeta {
  title: string;
  date: string | null;
  filename: string | null;
}

export interface SourceClient {
  readonly system: DocumentPickerSystem;
  /**
   * The instance this client talks to, as the normalised origin every source
   * key it produces carries (`sourceInstance`).
   */
  readonly instance: string;
  test(): Promise<void>;
  tags(): Promise<DocumentSourceTagDto[]>;
  search(
    params: SourceSearchParams,
  ): Promise<{ items: SourceListItem[]; hasMore: boolean }>;
  document(sourceId: string): Promise<SourceDocumentMeta>;
  download(
    sourceId: string,
    maxFileBytes: number,
  ): Promise<{ bytes: Uint8Array; filename: string | null }>;
}

export interface SourceConnection {
  system: DocumentPickerSystem;
  origin: string;
  baseUrl: string;
  organizationId: string | null;
  token: string;
}

/** Paperless tags are read this many per page. */
const TAG_PAGE_SIZE = 250;

/** Refuse an id that is not one the system issues, before it reaches a URL. */
function requireId(system: DocumentPickerSystem, id: string): void {
  if (!isSourceDocumentId(system, id)) {
    throw new DocumentSourceError("notFound");
  }
}

// ── Defensive readers ──────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** The body is not the shape the API documents: most often a base address
 *  that points at the web app instead of the instance. */
function shapeError(): DocumentSourceError {
  return new DocumentSourceError("badResponse");
}

/** YYYY-MM-DD from an ISO date or date-time, or null. */
export function dayOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function stripExtension(name: string | null): string {
  return name ? name.replace(/\.[A-Za-z0-9]{1,5}$/, "") : "";
}

/**
 * A title that is not blank and fits the vault: the source's title, else its
 * file name without the extension, else a placeholder naming the source id.
 */
export function titleOf(
  title: string | null,
  filename: string | null,
  fallback: string,
): string {
  const picked =
    (title ?? "").trim() || stripExtension(filename).trim() || fallback;
  return picked.slice(0, DOCUMENT_TITLE_MAX);
}

/** Is `day` inside the inclusive range? A document without a date is kept
 *  only when no range was asked for. */
export function withinRange(
  day: string | null,
  from: string | null,
  to: string | null,
): boolean {
  if (!from && !to) return true;
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

// ── Paperless-ngx ──────────────────────────────────────────────────────────

function paperless(connection: SourceConnection): SourceClient {
  const target: SourceTarget = {
    origin: connection.origin,
    baseUrl: connection.baseUrl,
    headers: {
      Authorization: `Token ${connection.token}`,
      Accept: `application/json; version=${PAPERLESS_API_VERSION}`,
    },
  };
  const download: SourceTarget = {
    ...target,
    headers: { Authorization: `Token ${connection.token}` },
  };

  /** A server that says which API version it speaks, and it is too old. */
  function checkVersion(response: Response): void {
    const raw = response.headers.get("x-api-version");
    if (raw === null) return;
    const version = Number(raw);
    if (Number.isFinite(version) && version < PAPERLESS_API_VERSION) {
      throw new DocumentSourceError("versionTooOld", response.status);
    }
  }

  async function tagMap(): Promise<Map<string, string>> {
    const tags = await listTags();
    return new Map(tags.map((tag) => [tag.id, tag.name]));
  }

  async function listTags(): Promise<DocumentSourceTagDto[]> {
    // Paged by number rather than by following `next`: the link is the
    // server's to write, the page number is ours.
    const tags: DocumentSourceTagDto[] = [];
    for (let pageNo = 1; tags.length < DOCUMENT_PICKER_MAX_TAGS; pageNo += 1) {
      const query = new URLSearchParams({
        page: String(pageNo),
        page_size: String(TAG_PAGE_SIZE),
        ordering: "name",
      });
      const { body, response } = await sourceJson(
        target,
        `/api/tags/?${query}`,
      );
      checkVersion(response);
      const page = asRecord(body);
      if (!page) throw shapeError();
      for (const raw of asArray(page.results)) {
        const tag = asRecord(raw);
        const id = asText(tag?.id);
        const name = asText(tag?.name);
        if (id && name) tags.push({ id, name });
      }
      if (typeof page.next !== "string" || !page.next) break;
    }
    return tags.slice(0, DOCUMENT_PICKER_MAX_TAGS);
  }

  return {
    system: "PAPERLESS",
    instance: connection.origin,

    async test() {
      const { body, response } = await sourceJson(
        target,
        "/api/documents/?page_size=1&fields=id",
      );
      checkVersion(response);
      if (!asRecord(body)) throw shapeError();
    },

    tags: listTags,

    async search(params) {
      const query = new URLSearchParams({
        page: String(params.page),
        page_size: String(DOCUMENT_PICKER_PAGE_SIZE),
        ordering: "-created",
        truncate_content: "true",
        fields: "id,title,created,added,tags,original_file_name",
      });
      if (params.q) query.set("title__icontains", params.q);
      if (params.tagId) query.set("tags__id__all", params.tagId);
      // API version 9 made `created` a plain date, so the range filters on
      // it directly (`created__gte` / `created__lte`), both ends inclusive.
      if (params.from) query.set("created__gte", params.from);
      if (params.to) query.set("created__lte", params.to);

      let page: Json | null;
      let names: Map<string, string>;
      try {
        const [list, tags] = await Promise.all([
          sourceJson(target, `/api/documents/?${query}`),
          tagMap(),
        ]);
        checkVersion(list.response);
        page = asRecord(list.body);
        names = tags;
      } catch (err) {
        // Paperless answers a page past the end with 404 ("Invalid page"):
        // there is simply nothing more.
        if (err instanceof DocumentSourceError && err.code === "notFound") {
          return { items: [], hasMore: false };
        }
        throw err;
      }
      if (!page) throw shapeError();

      const items: SourceListItem[] = [];
      for (const raw of asArray(page.results)) {
        const doc = asRecord(raw);
        const id = asText(doc?.id);
        if (!doc || !id || !isSourceDocumentId("PAPERLESS", id)) continue;
        const tagIds = asArray(doc.tags)
          .map(asText)
          .filter((t): t is string => t !== null);
        if (params.tagId && !tagIds.includes(params.tagId)) continue;
        const date = dayOf(doc.created) ?? dayOf(doc.added);
        if (!withinRange(date, params.from, params.to)) continue;
        items.push({
          sourceId: id,
          title: titleOf(
            asText(doc.title),
            asText(doc.original_file_name),
            `Paperless ${id}`,
          ),
          date,
          tags: tagIds
            .map((tagId) => names.get(tagId))
            .filter((n): n is string => typeof n === "string"),
          sizeBytes: null,
        });
      }
      return { items, hasMore: typeof page.next === "string" && !!page.next };
    },

    async document(sourceId) {
      requireId("PAPERLESS", sourceId);
      const { body, response } = await sourceJson(
        target,
        `/api/documents/${encodeURIComponent(sourceId)}/?fields=id,title,created,added,original_file_name`,
      );
      checkVersion(response);
      const doc = asRecord(body);
      if (!doc) throw shapeError();
      const filename = asText(doc.original_file_name);
      return {
        title: titleOf(asText(doc.title), filename, `Paperless ${sourceId}`),
        date: dayOf(doc.created) ?? dayOf(doc.added),
        filename,
      };
    },

    async download(sourceId, maxFileBytes) {
      requireId("PAPERLESS", sourceId);
      // The original, not the archived PDF/A: the same bytes a Paperless
      // workflow or the import script sends, so they dedup against each other.
      return sourceDownload(
        download,
        `/api/documents/${encodeURIComponent(sourceId)}/download/?original=true`,
        maxFileBytes,
      );
    },
  };
}

// ── Papra ──────────────────────────────────────────────────────────────────

/**
 * Papra's error bodies carry a machine code. Two of them mean "no such
 * organization" rather than "wrong key": a valid organization id the key's
 * user is not a member of (403 `user.not_in_organization`), and one Papra
 * cannot parse (400 `server.invalid_request.params`).
 */
function papraError(
  status: number,
  code: string | null,
): DocumentSourceErrorCode | null {
  if (status === 403 && code === "user.not_in_organization") return "notFound";
  if (status === 400 && code === "server.invalid_request.params") {
    return "notFound";
  }
  return null;
}

/** Papra's search syntax quotes a tag name that holds a space. */
function papraTagTerm(name: string): string {
  return /[\s"]/.test(name) ? `tag:${JSON.stringify(name)}` : `tag:${name}`;
}

function papra(connection: SourceConnection): SourceClient {
  if (
    !connection.organizationId ||
    !PAPRA_ORG_ID.test(connection.organizationId)
  ) {
    throw new DocumentSourceError("notFound");
  }
  const org = `/api/organizations/${encodeURIComponent(connection.organizationId)}`;
  const target: SourceTarget = {
    origin: connection.origin,
    baseUrl: connection.baseUrl,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      Accept: "application/json",
    },
    classify: papraError,
  };
  const download: SourceTarget = {
    ...target,
    headers: { Authorization: `Bearer ${connection.token}` },
  };

  async function listTags(): Promise<DocumentSourceTagDto[]> {
    const { body } = await sourceJson(target, `${org}/tags`);
    const page = asRecord(body);
    if (!page) throw shapeError();
    const tags: DocumentSourceTagDto[] = [];
    for (const raw of asArray(page.tags)) {
      const tag = asRecord(raw);
      const id = asText(tag?.id);
      const name = asText(tag?.name);
      if (id && name) tags.push({ id, name });
    }
    return tags
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, DOCUMENT_PICKER_MAX_TAGS);
  }

  return {
    system: "PAPRA",
    instance: connection.origin,

    async test() {
      const { body } = await sourceJson(
        target,
        `${org}/documents?pageIndex=0&pageSize=1`,
      );
      if (!asRecord(body)) throw shapeError();
      // The tag filter needs `tags:read`; a key without it would save green
      // and then fail on the first search.
      try {
        await sourceJson(target, `${org}/tags`);
      } catch (err) {
        if (err instanceof DocumentSourceError && err.code === "authRefused") {
          throw new DocumentSourceError(
            "permissionMissing",
            err.upstreamStatus,
          );
        }
        throw err;
      }
    },

    tags: listTags,

    async search(params) {
      // Each word quoted: Papra reads a leading `-` as a negation and a `:` as
      // a field, and a quoted word still matches as a prefix.
      const terms: string[] = params.q
        .split(/\s+/)
        .map((word) => word.replace(/"/g, ""))
        .filter((word) => word.length > 0)
        .map((word) => `"${word}"`);
      if (params.tagId) {
        const tag = (await listTags()).find((t) => t.id === params.tagId);
        // A tag that no longer exists matches nothing, rather than silently
        // dropping the filter and listing everything.
        if (!tag) return { items: [], hasMore: false };
        terms.push(papraTagTerm(tag.name));
      }
      // The range goes to Papra as its own `date:` filter; the check on each
      // row below stays as the net for a version that reads it differently.
      if (params.from) terms.push(`date:>=${params.from}`);
      if (params.to) terms.push(`date:<=${params.to}`);
      const pageIndex = params.page - 1;
      const query = new URLSearchParams({
        pageIndex: String(pageIndex),
        pageSize: String(DOCUMENT_PICKER_PAGE_SIZE),
      });
      if (terms.length > 0) query.set("searchQuery", terms.join(" "));
      const { body } = await sourceJson(target, `${org}/documents?${query}`);
      const page = asRecord(body);
      if (!page) throw shapeError();

      const documents = asArray(page.documents);
      const items: SourceListItem[] = [];
      for (const raw of documents) {
        const doc = asRecord(raw);
        const id = asText(doc?.id);
        if (!doc || !id || !isSourceDocumentId("PAPRA", id)) continue;
        const tags = asArray(doc.tags)
          .map(asRecord)
          .filter((t): t is Json => t !== null);
        if (params.tagId && !tags.some((t) => asText(t.id) === params.tagId)) {
          continue;
        }
        // The row shows the document date only, the field Papra's `date:`
        // filter reads, so the list and the filter agree: an undated document
        // shows no date and falls out of any range. The check below is the net
        // for a server that ignores the filter. The upload day is used only
        // on import, where a filing date is needed (see `document()`).
        const date = dayOf(doc.documentDate);
        if (!withinRange(date, params.from, params.to)) continue;
        const size = doc.originalSize;
        items.push({
          sourceId: id,
          title: titleOf(
            stripExtension(asText(doc.name)),
            asText(doc.originalName),
            `Papra ${id}`,
          ),
          date,
          tags: tags
            .map((t) => asText(t.name))
            .filter((n): n is string => n !== null),
          sizeBytes: typeof size === "number" && size >= 0 ? size : null,
        });
      }
      const total =
        typeof page.documentsCount === "number" ? page.documentsCount : null;
      const hasMore =
        total !== null
          ? (pageIndex + 1) * DOCUMENT_PICKER_PAGE_SIZE < total
          : documents.length >= DOCUMENT_PICKER_PAGE_SIZE;
      return { items, hasMore };
    },

    async document(sourceId) {
      requireId("PAPRA", sourceId);
      const { body } = await sourceJson(
        target,
        `${org}/documents/${encodeURIComponent(sourceId)}`,
      );
      const doc = asRecord(asRecord(body)?.document);
      if (!doc) throw shapeError();
      const filename = asText(doc.originalName) ?? asText(doc.name);
      return {
        title: titleOf(
          stripExtension(asText(doc.name)),
          filename,
          `Papra ${sourceId}`,
        ),
        date: dayOf(doc.documentDate) ?? dayOf(doc.createdAt),
        filename,
      };
    },

    async download(sourceId, maxFileBytes) {
      requireId("PAPRA", sourceId);
      return sourceDownload(
        download,
        `${org}/documents/${encodeURIComponent(sourceId)}/file`,
        maxFileBytes,
      );
    },
  };
}

export function sourceClient(connection: SourceConnection): SourceClient {
  return connection.system === "PAPERLESS"
    ? paperless(connection)
    : papra(connection);
}
