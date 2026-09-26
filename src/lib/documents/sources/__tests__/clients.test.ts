/**
 * The Paperless-ngx and Papra adapters against recorded response shapes, with
 * the network mocked at `safeFetch`. What these pin:
 *
 *   - every request carries the listed origin as the operator-approved pin and
 *     forbids redirects, and a 3xx is reported, not followed;
 *   - the source's own query parameters (name, tag, date, page), and the local
 *     re-check that keeps a server ignoring a filter from widening a result;
 *   - the error mapping (401 → authRefused, 406 / an old X-Api-Version →
 *     versionTooOld, 404 → notFound, non-JSON → badResponse, a refused or dead
 *     host → unreachable);
 *   - the byte caps on JSON and on a download.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const safeFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch };
});

import { SafeFetchError } from "@/lib/safe-fetch";

import { sourceClient } from "../clients";
import {
  DocumentSourceError,
  DocumentSourceTooLargeError,
  SOURCE_JSON_MAX_BYTES,
} from "../http";

const PAPERLESS = {
  system: "PAPERLESS" as const,
  origin: "http://paperless.lan:8000",
  baseUrl: "http://paperless.lan:8000/paperless",
  organizationId: null,
  token: "pl-secret-token",
};

const PAPRA = {
  system: "PAPRA" as const,
  origin: "https://papra.example.com",
  baseUrl: "https://papra.example.com",
  organizationId: "org_a1b2c3d4e5f6g7h8i9j0k1l2",
  token: "ppk_secret",
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Route mocked requests by path; anything unmatched is a 404. */
function serve(routes: Record<string, (url: URL) => Response>) {
  safeFetch.mockImplementation(async (target: string) => {
    const url = new URL(target);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.pathname.startsWith(prefix)) return handler(url);
    }
    return new Response("not found", { status: 404 });
  });
}

function calledUrls(): URL[] {
  return safeFetch.mock.calls.map((c) => new URL(String(c[0])));
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a failure");
}

beforeEach(() => {
  safeFetch.mockReset();
});

describe("every request is pinned to the listed origin", () => {
  it("passes the origin as the operator-approved pin and forbids redirects", async () => {
    serve({ "/paperless/api/documents/": () => json({ results: [] }) });
    await sourceClient(PAPERLESS).test();
    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [target, init, opts] = safeFetch.mock.calls[0];
    expect(String(target)).toBe(
      "http://paperless.lan:8000/paperless/api/documents/?page_size=1&fields=id",
    );
    expect(init.redirect).toBe("manual");
    expect(init.headers.Authorization).toBe("Token pl-secret-token");
    expect(init.headers.Accept).toBe("application/json; version=9");
    expect(opts.operatorApprovedPrivateOrigin).toBe(
      "http://paperless.lan:8000",
    );
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.requirePublicHost).toBeUndefined();
  });

  it("reports a redirect instead of following it", async () => {
    serve({
      "/paperless/api/documents/": () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    });
    const err = await failure(sourceClient(PAPERLESS).test());
    expect(err).toBeInstanceOf(DocumentSourceError);
    expect((err as DocumentSourceError).code).toBe("redirected");
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it("reports a refused or dead destination as unreachable", async () => {
    safeFetch.mockRejectedValue(new SafeFetchError("refused", "private_host"));
    const err = await failure(sourceClient(PAPRA).test());
    expect((err as DocumentSourceError).code).toBe("unreachable");
  });
});

describe("Paperless-ngx", () => {
  const tags = {
    results: [
      { id: 7, name: "Health" },
      { id: 9, name: "Insurance" },
    ],
    next: null,
  };

  it("searches by title with tag, date and page, and names the tags", async () => {
    serve({
      "/paperless/api/tags/": () => json(tags),
      "/paperless/api/documents/": () =>
        json({
          count: 30,
          next: "http://paperless.lan:8000/paperless/api/documents/?page=3",
          results: [
            {
              id: 41,
              title: "Blood test",
              created: "2025-03-04",
              tags: [7],
              original_file_name: "labor.pdf",
            },
            // A server that ignored the tag filter must not widen the result.
            { id: 42, title: "Car", created: "2025-03-05", tags: [9] },
            // Nor one that ignored the date filter.
            { id: 43, title: "Old", created: "2019-01-01", tags: [7] },
            // No title: the file name without its extension.
            {
              id: 44,
              title: " ",
              created: "2025-06-01T10:00:00+02:00",
              tags: [7],
              original_file_name: "discharge-letter.pdf",
            },
          ],
        }),
    });
    const result = await sourceClient(PAPERLESS).search({
      q: "blood",
      tagId: "7",
      from: "2025-01-01",
      to: "2025-12-31",
      page: 2,
    });

    const list = calledUrls().find((u) => u.pathname.endsWith("/documents/"));
    expect(list?.searchParams.get("title__icontains")).toBe("blood");
    expect(list?.searchParams.get("tags__id__all")).toBe("7");
    expect(list?.searchParams.get("created__gte")).toBe("2025-01-01");
    expect(list?.searchParams.get("created__lte")).toBe("2025-12-31");
    // API version 9 made `created` a date; the `__date` lookups are gone.
    expect(list?.searchParams.has("created__date__gte")).toBe(false);
    expect(list?.searchParams.get("page")).toBe("2");
    expect(list?.searchParams.get("page_size")).toBe("25");

    expect(result.hasMore).toBe(true);
    expect(result.items).toEqual([
      {
        sourceId: "41",
        title: "Blood test",
        date: "2025-03-04",
        tags: ["Health"],
        sizeBytes: null,
      },
      {
        sourceId: "44",
        title: "discharge-letter",
        date: "2025-06-01",
        tags: ["Health"],
        sizeBytes: null,
      },
    ]);
  });

  it("answers a page past the end with nothing", async () => {
    serve({
      "/paperless/api/tags/": () => json(tags),
      "/paperless/api/documents/": () =>
        json({ detail: "Invalid page." }, { status: 404 }),
    });
    await expect(
      sourceClient(PAPERLESS).search({
        q: "",
        tagId: null,
        from: null,
        to: null,
        page: 99,
      }),
    ).resolves.toEqual({ items: [], hasMore: false });
  });

  it("maps a refused token, an unsupported version and an old server", async () => {
    serve({ "/paperless/api/": () => json({}, { status: 401 }) });
    expect(
      ((await failure(sourceClient(PAPERLESS).test())) as DocumentSourceError)
        .code,
    ).toBe("authRefused");

    serve({ "/paperless/api/": () => json({}, { status: 406 }) });
    expect(
      ((await failure(sourceClient(PAPERLESS).test())) as DocumentSourceError)
        .code,
    ).toBe("versionTooOld");

    serve({
      "/paperless/api/": () =>
        json({ results: [] }, { headers: { "x-api-version": "5" } }),
    });
    expect(
      ((await failure(sourceClient(PAPERLESS).test())) as DocumentSourceError)
        .code,
    ).toBe("versionTooOld");
  });

  it("reports a web page where the API should be as a bad response", async () => {
    serve({
      "/paperless/api/": () =>
        new Response("<html>login</html>", {
          headers: { "content-type": "text/html" },
        }),
    });
    const err = await failure(sourceClient(PAPERLESS).test());
    expect((err as DocumentSourceError).code).toBe("badResponse");
  });

  it("refuses a JSON answer larger than the cap", async () => {
    serve({
      "/paperless/api/": () =>
        new Response("x".repeat(SOURCE_JSON_MAX_BYTES + 10), { status: 200 }),
    });
    const err = await failure(sourceClient(PAPERLESS).test());
    expect((err as DocumentSourceError).code).toBe("badResponse");
  });

  it("reads a document's details and downloads the original, within the cap", async () => {
    serve({
      "/paperless/api/documents/41/download/": () =>
        new Response(new Uint8Array([37, 80, 68, 70]), {
          headers: { "content-disposition": 'attachment; filename="x.pdf"' },
        }),
      "/paperless/api/documents/41/": () =>
        json({
          id: 41,
          title: "Blood test",
          created: "2025-03-04",
          original_file_name: "labor.pdf",
        }),
    });
    const client = sourceClient(PAPERLESS);
    await expect(client.document("41")).resolves.toEqual({
      title: "Blood test",
      date: "2025-03-04",
      filename: "labor.pdf",
    });
    const file = await client.download("41", 1024);
    expect([...file.bytes]).toEqual([37, 80, 68, 70]);
    expect(file.filename).toBe("x.pdf");
    const download = calledUrls().at(-1);
    expect(download?.searchParams.get("original")).toBe("true");
  });

  it("refuses a download larger than the vault accepts, declared or not", async () => {
    serve({
      "/paperless/api/documents/41/download/": () =>
        new Response(new Uint8Array(2048), {
          headers: { "content-length": "2048" },
        }),
    });
    expect(
      await failure(sourceClient(PAPERLESS).download("41", 1024)),
    ).toBeInstanceOf(DocumentSourceTooLargeError);

    serve({
      "/paperless/api/documents/41/download/": () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(800));
              controller.enqueue(new Uint8Array(800));
              controller.close();
            },
          }),
        ),
    });
    expect(
      await failure(sourceClient(PAPERLESS).download("41", 1024)),
    ).toBeInstanceOf(DocumentSourceTooLargeError);
  });
});

describe("ids never shape a request path", () => {
  it("refuses a Paperless id that is not a number, and dot segments, before dialling", async () => {
    const client = sourceClient(PAPERLESS);
    for (const id of ["..", ".", "41/../x", "abc", "41?x=1"]) {
      const err = await failure(client.document(id));
      expect((err as DocumentSourceError).code, id).toBe("notFound");
      expect(
        ((await failure(client.download(id, 10))) as DocumentSourceError).code,
      ).toBe("notFound");
    }
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("refuses a Papra id or organization id outside [A-Za-z0-9_-]", async () => {
    for (const id of ["..", "doc/1", "doc%2F1", "doc 1"]) {
      await failure(sourceClient(PAPRA).document(id));
    }
    expect(() =>
      sourceClient({ ...PAPRA, organizationId: "../admin" }),
    ).toThrow(DocumentSourceError);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("leaves a result with an unusable id out of the list", async () => {
    serve({
      "/paperless/api/tags/": () => json({ results: [], next: null }),
      "/paperless/api/documents/": () =>
        json({
          next: null,
          results: [
            { id: "..", title: "Odd", created: "2025-01-01", tags: [] },
            { id: 5, title: "Fine", created: "2025-01-01", tags: [] },
          ],
        }),
    });
    const result = await sourceClient(PAPERLESS).search({
      q: "",
      tagId: null,
      from: null,
      to: null,
      page: 1,
    });
    expect(result.items.map((i) => i.sourceId)).toEqual(["5"]);
  });
});

describe("Paperless-ngx tags", () => {
  it("pages through tags beyond the first 250", async () => {
    serve({
      "/paperless/api/tags/": (url) => {
        const page = Number(url.searchParams.get("page"));
        const results = Array.from(
          { length: page === 1 ? 250 : 3 },
          (_, i) => ({
            id: page * 1000 + i,
            name: `t${page}-${i}`,
          }),
        );
        return json({ results, next: page === 1 ? "more" : null });
      },
    });
    const tags = await sourceClient(PAPERLESS).tags();
    expect(tags).toHaveLength(253);
    expect(calledUrls().map((u) => u.searchParams.get("page"))).toEqual([
      "1",
      "2",
    ]);
  });
});

describe("Papra, as it answers for real", () => {
  it("quotes each word so a leading dash is not a negation, and sends the date range", async () => {
    serve({
      "/api/organizations/org_a1b2c3d4e5f6g7h8i9j0k1l2/documents": () =>
        json({ documents: [], documentsCount: 0 }),
    });
    await sourceClient(PAPRA).search({
      q: "-Knie  Entlass",
      tagId: null,
      from: "2024-01-01",
      to: "2024-12-31",
      page: 1,
    });
    const list = calledUrls().find((u) => u.pathname.endsWith("/documents"));
    expect(list?.searchParams.get("searchQuery")).toBe(
      '"-Knie" "Entlass" date:>=2024-01-01 date:<=2024-12-31',
    );
  });

  it("dates a search row by its document date only, as Papra's date filter does", async () => {
    serve({
      "/api/organizations/org_a1b2c3d4e5f6g7h8i9j0k1l2/documents": () =>
        json({
          documentsCount: 2,
          documents: [
            {
              id: "doc_dated",
              name: "A.pdf",
              documentDate: "2024-05-01",
              createdAt: "2025-01-01T00:00:00.000Z",
            },
            {
              id: "doc_undated",
              name: "B.pdf",
              createdAt: "2025-01-01T00:00:00.000Z",
            },
          ],
        }),
    });
    const all = await sourceClient(PAPRA).search({
      q: "",
      tagId: null,
      from: null,
      to: null,
      page: 1,
    });
    expect(all.items.map((i) => [i.sourceId, i.date])).toEqual([
      ["doc_dated", "2024-05-01"],
      ["doc_undated", null],
    ]);
    const ranged = await sourceClient(PAPRA).search({
      q: "",
      tagId: null,
      from: "2024-01-01",
      to: "2025-12-31",
      page: 1,
    });
    // Papra's date: filter never matches a document without a document date;
    // the per-row check agrees instead of re-admitting it by upload day.
    expect(ranged.items.map((i) => i.sourceId)).toEqual(["doc_dated"]);
  });

  it("still files an undated Papra document under the day it was added on import", async () => {
    serve({
      "/api/organizations/org_a1b2c3d4e5f6g7h8i9j0k1l2/documents/doc_undated":
        () =>
          json({
            document: {
              id: "doc_undated",
              name: "B.pdf",
              createdAt: "2025-01-01T09:00:00.000Z",
            },
          }),
    });
    await expect(
      sourceClient(PAPRA).document("doc_undated"),
    ).resolves.toMatchObject({
      date: "2025-01-01",
    });
  });

  it("refuses an organization id Papra would not issue", () => {
    for (const org of ["org_123", "../admin", "ORG_A1B2C3D4E5F6G7H8I9J0K1L2"]) {
      expect(() => sourceClient({ ...PAPRA, organizationId: org })).toThrow(
        DocumentSourceError,
      );
    }
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("reads 'not in this organization' and a malformed id as no such organization", async () => {
    serve({
      "/api/organizations/": () =>
        json({ error: { code: "user.not_in_organization" } }, { status: 403 }),
    });
    expect(
      ((await failure(sourceClient(PAPRA).test())) as DocumentSourceError).code,
    ).toBe("notFound");
    serve({
      "/api/organizations/": () =>
        json(
          { error: { code: "server.invalid_request.params" } },
          { status: 400 },
        ),
    });
    expect(
      ((await failure(sourceClient(PAPRA).test())) as DocumentSourceError).code,
    ).toBe("notFound");
    // Any other refusal of the key is still the key.
    serve({
      "/api/organizations/": () =>
        json({ error: { code: "auth.unauthorized" } }, { status: 401 }),
    });
    expect(
      ((await failure(sourceClient(PAPRA).test())) as DocumentSourceError).code,
    ).toBe("authRefused");
  });

  it("fails the connection test when the key cannot read tags", async () => {
    serve({
      "/api/organizations/org_a1b2c3d4e5f6g7h8i9j0k1l2/tags": () =>
        json({}, { status: 401 }),
      "/api/organizations/org_a1b2c3d4e5f6g7h8i9j0k1l2/documents": () =>
        json({ documents: [], documentsCount: 0 }),
    });
    const err = await failure(sourceClient(PAPRA).test());
    expect((err as DocumentSourceError).code).toBe("permissionMissing");
  });
});

describe("Papra", () => {
  const tags = {
    tags: [
      { id: "tag_b", name: "Lab results" },
      { id: "tag_a", name: "Health" },
    ],
  };

  it("sends the name and the tag through searchQuery and re-checks both", async () => {
    serve({
      "/api/organizations/org_a1b2c3d4e5f6g7h8i9j0k1l2/tags": () => json(tags),
      "/api/organizations/org_a1b2c3d4e5f6g7h8i9j0k1l2/documents": () =>
        json({
          documentsCount: 60,
          documents: [
            {
              id: "doc_1",
              name: "Blood test.pdf",
              originalName: "Blood test.pdf",
              originalSize: 1234,
              documentDate: "2025-03-04",
              createdAt: "2025-03-04T09:00:00.000Z",
              tags: [{ id: "tag_b", name: "Lab results" }],
            },
            {
              id: "doc_2",
              name: "Other.pdf",
              createdAt: "2025-03-04T09:00:00.000Z",
              tags: [{ id: "tag_a", name: "Health" }],
            },
            {
              id: "doc_3",
              name: "Too old.pdf",
              documentDate: "2018-01-01",
              createdAt: "2025-03-04T09:00:00.000Z",
              tags: [{ id: "tag_b", name: "Lab results" }],
            },
          ],
        }),
    });
    const result = await sourceClient(PAPRA).search({
      q: "blood",
      tagId: "tag_b",
      from: "2025-01-01",
      to: null,
      page: 1,
    });
    const list = calledUrls().find((u) => u.pathname.endsWith("/documents"));
    expect(list?.searchParams.get("searchQuery")).toBe(
      '"blood" tag:"Lab results" date:>=2025-01-01',
    );
    expect(list?.searchParams.get("pageIndex")).toBe("0");
    expect(list?.searchParams.get("pageSize")).toBe("25");
    expect(safeFetch.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer ppk_secret",
    );
    expect(result).toEqual({
      items: [
        {
          sourceId: "doc_1",
          title: "Blood test",
          date: "2025-03-04",
          tags: ["Lab results"],
          sizeBytes: 1234,
        },
      ],
      hasMore: true,
    });
  });

  it("matches nothing for a tag that no longer exists", async () => {
    serve({
      "/api/organizations/org_a1b2c3d4e5f6g7h8i9j0k1l2/tags": () => json(tags),
    });
    await expect(
      sourceClient(PAPRA).search({
        q: "",
        tagId: "tag_gone",
        from: null,
        to: null,
        page: 1,
      }),
    ).resolves.toEqual({ items: [], hasMore: false });
    expect(calledUrls().some((u) => u.pathname.endsWith("/documents"))).toBe(
      false,
    );
  });

  it("lists tags by name and maps an unknown organization to notFound", async () => {
    serve({
      "/api/organizations/org_a1b2c3d4e5f6g7h8i9j0k1l2/tags": () => json(tags),
    });
    await expect(sourceClient(PAPRA).tags()).resolves.toEqual([
      { id: "tag_a", name: "Health" },
      { id: "tag_b", name: "Lab results" },
    ]);

    serve({});
    const err = await failure(sourceClient(PAPRA).test());
    expect((err as DocumentSourceError).code).toBe("notFound");
  });

  it("reads a document and downloads its file", async () => {
    serve({
      "/api/organizations/org_a1b2c3d4e5f6g7h8i9j0k1l2/documents/doc_1/file":
        () => new Response(new Uint8Array([1, 2, 3])),
      "/api/organizations/org_a1b2c3d4e5f6g7h8i9j0k1l2/documents/doc_1": () =>
        json({
          document: {
            id: "doc_1",
            name: "Blood test.pdf",
            originalName: "blood.pdf",
            documentDate: "2025-02-01",
            createdAt: "2025-03-04T09:00:00.000Z",
          },
        }),
    });
    const client = sourceClient(PAPRA);
    await expect(client.document("doc_1")).resolves.toEqual({
      title: "Blood test",
      date: "2025-02-01",
      filename: "blood.pdf",
    });
    const file = await client.download("doc_1", 1024);
    expect([...file.bytes]).toEqual([1, 2, 3]);
  });
});
