/**
 * The document picker (#1038) against a real Postgres, the real auth resolver
 * and the real routes. Only the network is replaced: `safeFetch` answers from
 * an in-memory Paperless-ngx, so every assertion about what was fetched (and
 * what was not) is a count on that fake.
 *
 *   1. With `DOCUMENT_SOURCE_ORIGINS` unset the picker is off.
 *   2. Saving refuses an unlisted origin and a refused token, stores nothing
 *      then, and otherwise stores the token encrypted and never returns it.
 *   3. Only the owner's browser session reaches the routes: a `["*"]` Bearer
 *      and a delegate acting on the owner's record are refused.
 *   4. Search reports what the vault holds per source key; import stores
 *      through the upload's ingest path with provenance; a re-import is a
 *      duplicate and a document deleted in HealthLog stays deleted, both
 *      without a download.
 *   5. An import links to the record it was picked for, and a foreign record
 *      is refused before anything is fetched.
 *   6. An origin the operator removed cuts the stored connection off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-document-sources-32-bytes-min-0987654321abcd";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// ── The fake Paperless-ngx behind `safeFetch` ──────────────────────────────

const ORIGIN = "http://paperless.lan:8000";
const TOKEN = "paperless-token-0123456789-secret";

const PDF = (tag: string) =>
  Buffer.from(`%PDF-1.7\n% ${tag}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`);

const DOCS = [
  {
    id: 41,
    title: "Blood test",
    created: "2024-03-04",
    tags: [7],
    original_file_name: "blood.pdf",
    bytes: PDF("blood"),
  },
  {
    id: 42,
    title: "Discharge letter",
    created: "2023-11-20",
    tags: [],
    original_file_name: "discharge.pdf",
    bytes: PDF("discharge"),
  },
];

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; opts: Record<string, unknown> }>,
  acceptToken: "",
}));

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: vi.fn(
      async (
        target: string,
        init: RequestInit,
        opts: Record<string, unknown>,
      ) => {
        fake.calls.push({ url: String(target), opts });
        const url = new URL(String(target));
        if (url.origin !== opts.operatorApprovedPrivateOrigin) {
          throw new actual.SafeFetchError("not approved", "private_host");
        }
        const auth = (init.headers as Record<string, string>).Authorization;
        if (auth !== `Token ${fake.acceptToken}`) {
          return new Response("{}", { status: 401 });
        }
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" },
          });
        const path = url.pathname;
        if (path === "/api/tags/") {
          return json({ results: [{ id: 7, name: "Health" }], next: null });
        }
        if (path === "/api/documents/") {
          const q = (
            url.searchParams.get("title__icontains") ?? ""
          ).toLowerCase();
          return json({
            next: null,
            results: DOCS.filter((d) => d.title.toLowerCase().includes(q)).map(
              ({ bytes: _bytes, ...doc }) => doc,
            ),
          });
        }
        const download = /^\/api\/documents\/(\d+)\/download\/$/.exec(path);
        if (download) {
          const doc = DOCS.find((d) => String(d.id) === download[1]);
          return doc
            ? new Response(new Uint8Array(doc.bytes))
            : new Response("", { status: 404 });
        }
        const detail = /^\/api\/documents\/(\d+)\/$/.exec(path);
        if (detail) {
          const doc = DOCS.find((d) => String(d.id) === detail[1]);
          if (!doc) return new Response("{}", { status: 404 });
          const { bytes: _bytes, ...meta } = doc;
          return json(meta);
        }
        return new Response("{}", { status: 404 });
      },
    ),
  };
});

import { decrypt } from "@/lib/crypto";
import { hashToken } from "@/lib/auth/hmac";
import { acceptGrant, inviteGrant } from "@/lib/sharing/grants";

// ── Helpers ────────────────────────────────────────────────────────────────

let userId = "";
let sessionId = "";

async function makeUser(name: string) {
  return getPrismaClient().user.create({
    data: {
      username: name,
      email: `${name}@example.test`,
      role: "USER",
      timezone: "UTC",
      modulePreferencesJson: { inboundDocuments: true },
    },
  });
}

async function signIn(id: string) {
  return getPrismaClient().session.create({
    data: { userId: id, expiresAt: new Date(Date.now() + 600_000) },
  });
}

async function seedOwner() {
  const user = await makeUser("owner");
  const session = await signIn(user.id);
  userId = user.id;
  sessionId = session.id;
  asCookie(sessionId);
}

function asCookie(id: string) {
  headerJar.clear();
  cookieJar.set("healthlog_session", id);
}

type Params = { params: Promise<{ system: string }> };
const paperless: Params = {
  params: Promise.resolve({ system: "paperless" }),
};
type Handler = (r: NextRequest, c: Params) => Promise<Response>;

function jsonRequest(url: string, method: string, body?: unknown) {
  const headers: Record<string, string> = {};
  const auth = headerJar.get("authorization");
  if (auth) headers.authorization = auth;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`https://health.example${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  } as never);
}

async function status(): Promise<Response> {
  const { GET } = await import("@/app/api/documents/sources/route");
  return (GET as unknown as (r: NextRequest) => Promise<Response>)(
    jsonRequest("/api/documents/sources", "GET"),
  );
}

async function save(body: unknown): Promise<Response> {
  const { PUT } = await import("@/app/api/documents/sources/[system]/route");
  return (PUT as unknown as Handler)(
    jsonRequest("/api/documents/sources/paperless", "PUT", body),
    paperless,
  );
}

async function disconnect(): Promise<Response> {
  const { DELETE } = await import("@/app/api/documents/sources/[system]/route");
  return (DELETE as unknown as Handler)(
    jsonRequest("/api/documents/sources/paperless", "DELETE"),
    paperless,
  );
}

async function search(query = ""): Promise<Response> {
  const { GET } =
    await import("@/app/api/documents/sources/[system]/search/route");
  return (GET as unknown as Handler)(
    jsonRequest(`/api/documents/sources/paperless/search?${query}`, "GET"),
    paperless,
  );
}

async function importDoc(body: unknown): Promise<Response> {
  const { POST } =
    await import("@/app/api/documents/sources/[system]/import/route");
  return (POST as unknown as Handler)(
    jsonRequest("/api/documents/sources/paperless/import", "POST", body),
    paperless,
  );
}

async function connect() {
  fake.acceptToken = TOKEN;
  const res = await save({ baseUrl: `${ORIGIN}/`, token: TOKEN });
  expect(res.status).toBe(200);
  return res;
}

function downloads(): number {
  return fake.calls.filter((c) => c.url.includes("/download/")).length;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  fake.calls.length = 0;
  fake.acceptToken = TOKEN;
  process.env.DOCUMENT_SOURCE_ORIGINS = ORIGIN;
});

afterEach(() => {
  delete process.env.DOCUMENT_SOURCE_ORIGINS;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("the operator's list switches the picker on", () => {
  it("is off without DOCUMENT_SOURCE_ORIGINS, and nothing is dialled", async () => {
    delete process.env.DOCUMENT_SOURCE_ORIGINS;
    await seedOwner();
    const off = await status();
    expect(off.status).toBe(200);
    expect((await off.json()).data).toEqual({
      available: false,
      allowedOrigins: [],
      connections: [],
    });
    const refused = await save({ baseUrl: ORIGIN, token: TOKEN });
    expect(refused.status).toBe(404);
    expect((await refused.json()).meta.errorCode).toBe(
      "documents.sources.unavailable",
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe("saving a connection", () => {
  it("refuses an origin the operator did not list, public or private, without dialling", async () => {
    await seedOwner();
    for (const baseUrl of [
      "http://10.0.0.9:8000",
      "https://paperless.example.org",
      "http://paperless.lan:8001",
    ]) {
      const res = await save({ baseUrl, token: TOKEN });
      expect(res.status, baseUrl).toBe(422);
      expect((await res.json()).meta.errorCode).toBe(
        "documents.sources.originNotAllowed",
      );
    }
    expect(fake.calls).toHaveLength(0);
    expect(await getPrismaClient().documentSourceConnection.count()).toBe(0);
  });

  it("refuses a token the source rejects and stores nothing", async () => {
    await seedOwner();
    fake.acceptToken = "the-real-one";
    const res = await save({ baseUrl: ORIGIN, token: TOKEN });
    expect(res.status).toBe(502);
    expect((await res.json()).meta).toMatchObject({
      errorCode: "documents.sources.authRefused",
      upstreamStatus: 401,
    });
    expect(await getPrismaClient().documentSourceConnection.count()).toBe(0);
  });

  it("stores the token encrypted and never returns it", async () => {
    await seedOwner();
    const saved = await connect();
    const savedText = await saved.text();
    expect(savedText).not.toContain(TOKEN);
    expect(JSON.parse(savedText).data).toMatchObject({
      system: "PAPERLESS",
      baseUrl: ORIGIN,
      hasToken: true,
      originAllowed: true,
    });

    const row =
      await getPrismaClient().documentSourceConnection.findFirstOrThrow();
    expect(row.userId).toBe(userId);
    expect(row.tokenEncrypted).not.toContain(TOKEN);
    expect(decrypt(row.tokenEncrypted)).toBe(TOKEN);

    const read = await (await status()).text();
    expect(read).not.toContain(TOKEN);
    expect(JSON.parse(read).data.allowedOrigins).toEqual([ORIGIN]);

    // A save without a token keeps the stored one.
    const again = await save({ baseUrl: ORIGIN });
    expect(again.status).toBe(200);
    const kept =
      await getPrismaClient().documentSourceConnection.findFirstOrThrow();
    expect(decrypt(kept.tokenEncrypted)).toBe(TOKEN);

    expect((await disconnect()).status).toBe(200);
    expect(await getPrismaClient().documentSourceConnection.count()).toBe(0);
  });
});

describe("only the owner's browser session", () => {
  it("refuses a wildcard Bearer token", async () => {
    await seedOwner();
    await connect();
    const raw = "hlk_document-sources-wildcard-token-000";
    await getPrismaClient().apiToken.create({
      data: {
        userId,
        name: "native",
        tokenHash: hashToken(raw),
        permissions: ["*"],
      },
    });
    cookieJar.clear();
    headerJar.set("authorization", `Bearer ${raw}`);
    fake.calls.length = 0;
    for (const res of [
      await status(),
      await search("q=blood"),
      await importDoc({ sourceId: "41" }),
    ]) {
      expect(res.status).toBe(403);
      expect((await res.json()).meta.errorCode).toBe(
        "documents.sources.browserOnly",
      );
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a delegate acting on the owner's record", async () => {
    await seedOwner();
    await connect();
    const delegate = await makeUser("delegate");
    const invited = await inviteGrant({
      grantorId: userId,
      granteeId: delegate.id,
      access: "WRITE",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
    const session = await signIn(delegate.id);
    const switched = await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: userId },
    });
    asCookie(session.id);
    headerJar.set("x-healthlog-record-epoch", String(switched.recordEpoch));
    headerJar.set("x-healthlog-record-scope", userId);
    fake.calls.length = 0;

    for (const res of [
      await status(),
      await search("q=blood"),
      await importDoc({ sourceId: "41" }),
    ]) {
      expect(res.status).toBe(403);
    }
    expect(fake.calls).toHaveLength(0);
    expect(await getPrismaClient().inboundDocument.count()).toBe(0);
  });
});

describe("search and import", () => {
  it("imports through the ingest path; a re-import is a duplicate and a deleted one stays deleted", async () => {
    await seedOwner();
    await connect();
    const prisma = getPrismaClient();

    const first = await search("q=blood");
    expect(first.status).toBe(200);
    expect((await first.json()).data).toEqual({
      page: 1,
      hasMore: false,
      results: [
        {
          sourceId: "41",
          title: "Blood test",
          date: "2024-03-04",
          tags: ["Health"],
          sizeBytes: null,
          state: "new",
          documentId: null,
        },
      ],
    });

    const imported = await importDoc({ sourceId: "41" });
    expect(imported.status).toBe(201);
    const receipt = (await imported.json()).data;
    expect(receipt).toMatchObject({ outcome: "imported", linked: false });
    const stored = await prisma.inboundDocument.findUniqueOrThrow({
      where: { id: receipt.documentId },
      omit: { contentEncrypted: true },
    });
    expect(stored).toMatchObject({
      userId,
      title: "Blood test",
      filename: "blood.pdf",
      sourceSystem: "PAPERLESS",
      sourceId: "41",
      mimeType: "application/pdf",
      aiReadDeferred: false,
      kind: "OTHER",
    });
    expect(stored.documentDate?.toISOString().slice(0, 10)).toBe("2024-03-04");
    expect(downloads()).toBe(1);

    const listed = (await (await search("q=blood")).json()).data.results[0];
    expect(listed).toMatchObject({
      state: "imported",
      documentId: receipt.documentId,
    });

    const again = await importDoc({ sourceId: "41" });
    expect(again.status).toBe(200);
    expect((await again.json()).data).toEqual({
      outcome: "duplicate",
      documentId: receipt.documentId,
      linked: false,
    });
    expect(downloads()).toBe(1);

    await prisma.inboundDocument.update({
      where: { id: receipt.documentId },
      data: { deletedAt: new Date() },
    });
    expect(
      (await (await search("q=blood")).json()).data.results[0],
    ).toMatchObject({ state: "deleted", documentId: null });
    const revived = await importDoc({ sourceId: "41" });
    expect(revived.status).toBe(200);
    expect((await revived.json()).data.outcome).toBe("deleted");
    expect(downloads()).toBe(1);
    expect(await prisma.inboundDocument.count()).toBe(1);
  });

  it("answers a file already uploaded by hand as a duplicate and remembers the key", async () => {
    await seedOwner();
    await connect();
    const prisma = getPrismaClient();

    // The same bytes, uploaded through the vault without a source key.
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(DOCS[1].bytes)]), "x.pdf");
    const { POST } = await import("@/app/api/documents/inbound/route");
    const uploaded = await (
      POST as unknown as (r: Request) => Promise<Response>
    )(
      new Request("http://localhost/api/documents/inbound", {
        method: "POST",
        body: form,
      }),
    );
    expect(uploaded.status).toBe(201);
    const uploadedId = (await uploaded.json()).data.id;

    const picked = await importDoc({ sourceId: "42" });
    expect(picked.status).toBe(200);
    expect((await picked.json()).data).toMatchObject({
      outcome: "duplicate",
      documentId: uploadedId,
    });
    expect(await prisma.inboundDocument.count()).toBe(1);
    expect(
      await prisma.documentSourceAlias.count({
        where: {
          documentId: uploadedId,
          sourceSystem: "PAPERLESS",
          sourceId: "42",
        },
      }),
    ).toBe(1);
  });

  it("links to the visit it was picked for, and refuses someone else's before fetching", async () => {
    await seedOwner();
    await connect();
    const prisma = getPrismaClient();
    const visit = await prisma.encounter.create({
      data: { userId, occurredAt: new Date("2024-03-04T10:00:00Z") },
    });
    const stranger = await makeUser("stranger");
    const foreign = await prisma.encounter.create({
      data: { userId: stranger.id, occurredAt: new Date() },
    });

    const refused = await importDoc({
      sourceId: "41",
      link: { kind: "encounter", id: foreign.id },
    });
    expect(refused.status).toBe(404);
    expect((await refused.json()).meta.errorCode).toBe(
      "documents.sources.linkTargetNotFound",
    );
    expect(downloads()).toBe(0);

    const linked = await importDoc({
      sourceId: "41",
      link: { kind: "encounter", id: visit.id },
    });
    expect(linked.status).toBe(201);
    const data = (await linked.json()).data;
    expect(data.linked).toBe(true);
    expect(
      await prisma.encounterDocumentLink.count({
        where: { encounterId: visit.id, documentId: data.documentId },
      }),
    ).toBe(1);
  });

  it("cuts a stored connection off once the operator removes its origin", async () => {
    await seedOwner();
    await connect();
    fake.calls.length = 0;
    process.env.DOCUMENT_SOURCE_ORIGINS = "https://other.example.com";

    const res = await search("q=blood");
    expect(res.status).toBe(422);
    expect((await res.json()).meta.errorCode).toBe(
      "documents.sources.originNotAllowed",
    );
    const imported = await importDoc({ sourceId: "41" });
    expect(imported.status).toBe(422);
    expect(fake.calls).toHaveLength(0);

    const read = (await (await status()).json()).data;
    expect(read.connections[0]).toMatchObject({ originAllowed: false });
    // Still removable.
    expect((await disconnect()).status).toBe(200);
  });
});
