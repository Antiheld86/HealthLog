/**
 * v1.11.0 (Epic C, C4) — owner clinician-share-link lifecycle.
 *
 * Asserts the security-load-bearing properties: create returns the raw token
 * exactly once and persists ONLY its hash; the expiry cap is enforced; revoke
 * flips `revokedAt`; a cross-user revoke is sealed as 404.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    clinicianShareLink: {
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    inboundDocument: {
      findMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: (s: string) => `hash(${s})` }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST, GET } from "../route";
import { DELETE } from "../[id]/route";
import { EMPTY_DOCTOR_REPORT_PREFS } from "@/lib/validations/doctor-report-prefs";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/share-links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    label: "Cardiology clinic",
    rangeStart: "2026-01-01T00:00:00Z",
    rangeEnd: null,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    label: "Cardiology clinic",
    rangeStart: new Date("2026-01-01T00:00:00Z"),
    rangeEnd: null,
    passphraseHash: "hash(STORED)",
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    revokedAt: null,
    lastAccessAt: null,
    accessCount: 0,
    _count: { documents: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: new Date(),
  } as never);
});

describe("POST /api/share-links — create", () => {
  it("returns the raw token once and persists ONLY its hash", async () => {
    vi.mocked(prisma.clinicianShareLink.create).mockResolvedValue(
      storedRow() as never,
    );

    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { token: string; id: string } };

    // Raw token returned, prefixed, and 48 hex chars (192-bit).
    expect(body.data.token).toMatch(/^hls_[0-9a-f]{48}$/);

    // The persisted data carries the HMAC hash, never the raw token.
    const createArg = vi.mocked(prisma.clinicianShareLink.create).mock
      .calls[0][0];
    expect(createArg.data.tokenHash).toBe(`hash(${body.data.token})`);
    // No column stores the raw token verbatim — only the (mock) hash wraps it.
    const { tokenHash, ...rest } = createArg.data;
    expect(tokenHash).not.toBe(body.data.token);
    expect(JSON.stringify(rest)).not.toContain(body.data.token);
    // userId is narrowed from the session, never the body.
    expect(createArg.data.userId).toBe("user-1");
  });

  it("returns the raw passphrase once and persists ONLY its hash", async () => {
    vi.mocked(prisma.clinicianShareLink.create).mockResolvedValue(
      storedRow({ passphraseHash: "hash(STORED)" }) as never,
    );

    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: {
        passphrase: string;
        token: string;
        shareUrl: string;
        qrUrl: string;
        protected: boolean;
      };
    };

    // The raw passphrase is returned exactly once in the grouped form.
    expect(body.data.passphrase).toMatch(
      /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/,
    );

    // Stored as a hash (the mock wraps the NORMALISED bare form), never raw.
    const createArg = vi.mocked(prisma.clinicianShareLink.create).mock
      .calls[0][0];
    const bare = body.data.passphrase.replace(/-/g, "");
    expect(createArg.data.passphraseHash).toBe(`hash(${bare})`);
    expect(createArg.data.passphraseHash).not.toContain(body.data.passphrase);

    // The QR payload carries the passphrase ONLY in the URL fragment (`#k=`),
    // never the path or query — and the bare share URL never carries it.
    expect(body.data.qrUrl).toContain(`#k=${body.data.passphrase}`);
    expect(body.data.shareUrl).not.toContain(body.data.passphrase);
    expect(body.data.shareUrl).toContain(`/c/${body.data.token}`);
    // Summary reports the link as passphrase-protected.
    expect(body.data.protected).toBe(true);
  });

  it("rejects an expiry beyond the cap (422)", async () => {
    const tooFar = new Date(
      Date.now() + 200 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const res = await POST(postReq(validBody({ expiresAt: tooFar })));
    expect(res.status).toBe(422);
    expect(prisma.clinicianShareLink.create).not.toHaveBeenCalled();
  });

  it("rejects a past expiry (422)", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const res = await POST(postReq(validBody({ expiresAt: past })));
    expect(res.status).toBe(422);
  });

  it("rejects an unknown key via strict schema (422)", async () => {
    const res = await POST(postReq(validBody({ userId: "attacker" })));
    expect(res.status).toBe(422);
    expect(prisma.clinicianShareLink.create).not.toHaveBeenCalled();
  });

  it("attaches own live documents in the create transaction (frozen write-once)", async () => {
    // The ownership probe returns exactly the requested (deduped) ids as live.
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([
      { id: "doc-a" },
      { id: "doc-b" },
    ] as never);
    vi.mocked(prisma.clinicianShareLink.create).mockResolvedValue(
      storedRow({ _count: { documents: 2 } }) as never,
    );

    const res = await POST(
      postReq(validBody({ documentIds: ["doc-a", "doc-b", "doc-a"] })),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { documentCount: number } };
    expect(body.data.documentCount).toBe(2);

    // Ownership was checked against the caller's own LIVE documents.
    const probeArg = vi.mocked(prisma.inboundDocument.findMany).mock
      .calls[0][0];
    expect(probeArg!.where).toEqual({
      id: { in: ["doc-a", "doc-b"] }, // deduped
      userId: "user-1",
      deletedAt: null,
    });

    // Membership rows are created NESTED in the same create call (one txn),
    // deduped, never widened afterwards.
    const createArg = vi.mocked(prisma.clinicianShareLink.create).mock
      .calls[0][0];
    expect(createArg.data.documents).toEqual({
      create: [{ documentId: "doc-a" }, { documentId: "doc-b" }],
    });
  });

  it("rejects a foreign / deleted document id at create (422, no link minted)", async () => {
    // Only one of the two requested ids resolves as the caller's own live doc.
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([
      { id: "doc-a" },
    ] as never);

    const res = await POST(
      postReq(validBody({ documentIds: ["doc-a", "not-mine"] })),
    );
    expect(res.status).toBe(422);
    // No share is ever minted with a document the caller does not own (B5).
    expect(prisma.clinicianShareLink.create).not.toHaveBeenCalled();
  });

  it("rejects more than the document cap via strict schema (422)", async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `doc-${i}`);
    const res = await POST(postReq(validBody({ documentIds: tooMany })));
    expect(res.status).toBe(422);
    expect(prisma.inboundDocument.findMany).not.toHaveBeenCalled();
    expect(prisma.clinicianShareLink.create).not.toHaveBeenCalled();
  });

  it("rejects the retired FHIR scope keys with 422", async () => {
    // The share link has never served FHIR against its token. The keys
    // are gone from the create schema rather than accepted and ignored, so a
    // stale client is told plainly instead of believing it scoped something.
    const res = await POST(
      postReq(
        validBody({ allowFhirApi: true, resourceTypes: ["Observation"] }),
      ),
    );
    expect(res.status).toBe(422);
    expect(prisma.clinicianShareLink.create).not.toHaveBeenCalled();
  });

  it("allows a documents-only share (empty report sections)", async () => {
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([
      { id: "doc-a" },
    ] as never);
    vi.mocked(prisma.clinicianShareLink.create).mockResolvedValue(
      storedRow({ _count: { documents: 1 } }) as never,
    );
    const res = await POST(postReq(validBody({ documentIds: ["doc-a"] })));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { documentCount: number } };
    expect(body.data.documentCount).toBe(1);
  });

  it("documentOnly FORCES an empty report scope even when the body smuggles one", async () => {
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([
      { id: "doc-a" },
    ] as never);
    vi.mocked(prisma.clinicianShareLink.create).mockResolvedValue(
      storedRow({ _count: { documents: 1 } }) as never,
    );

    // A hostile / stale client tries to widen a document link into a record
    // share by requesting sections. The server must ignore them.
    const res = await POST(
      postReq(
        validBody({
          documentOnly: true,
          sections: { vitals: { bp: true }, labs: true },
          documentIds: ["doc-a"],
        }),
      ),
    );
    expect(res.status).toBe(201);

    const createArg = vi.mocked(prisma.clinicianShareLink.create).mock
      .calls[0][0];
    // The retired FHIR scope columns are never written at all.
    expect(createArg.data).not.toHaveProperty("resourceTypes");
    expect(createArg.data).not.toHaveProperty("allowFhirApi");
    // Sections persist as an explicit all-OFF blob (distinct from `{}` = full
    // record defaults). The clinician view reads this as "no report".
    expect(createArg.data.sectionsJson).toEqual(EMPTY_DOCTOR_REPORT_PREFS);
    // v1.28.16 — the frozen documents-only flag is persisted so the view path
    // gates on the column, not on inferring "all sections off". This is what a
    // future report section can never re-open.
    expect(createArg.data.documentOnly).toBe(true);
    // The picked document still rides along.
    expect(createArg.data.documents).toEqual({
      create: [{ documentId: "doc-a" }],
    });
  });

  it("rejects a documentOnly share with no documents (422)", async () => {
    const res = await POST(postReq(validBody({ documentOnly: true })));
    expect(res.status).toBe(422);
    expect(prisma.clinicianShareLink.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/share-links — list", () => {
  it("never returns a raw token", async () => {
    vi.mocked(prisma.clinicianShareLink.findMany).mockResolvedValue([
      storedRow(),
    ] as never);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { shareLinks: Array<Record<string, unknown>> };
    };
    expect(body.data.shareLinks).toHaveLength(1);
    expect(JSON.stringify(body.data)).not.toContain("hls_");
    // Scoped to the caller.
    const arg = vi.mocked(prisma.clinicianShareLink.findMany).mock.calls[0][0];
    expect(arg!.where).toEqual({ userId: "user-1" });
  });
});

describe("DELETE /api/share-links/[id] — revoke", () => {
  function delReq(): NextRequest {
    return new NextRequest("http://localhost/api/share-links/link-1", {
      method: "DELETE",
    });
  }

  it("revokes an own link (sets revokedAt, pins userId)", async () => {
    vi.mocked(prisma.clinicianShareLink.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    const res = await DELETE(delReq(), {
      params: Promise.resolve({ id: "link-1" }),
    });
    expect(res.status).toBe(200);
    const arg = vi.mocked(prisma.clinicianShareLink.updateMany).mock
      .calls[0][0];
    expect(arg.where).toEqual({
      id: "link-1",
      userId: "user-1",
      revokedAt: null,
    });
    expect(arg.data.revokedAt).toBeInstanceOf(Date);
  });

  it("seals a cross-user / unknown id as 404", async () => {
    vi.mocked(prisma.clinicianShareLink.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    const res = await DELETE(delReq(), {
      params: Promise.resolve({ id: "someone-elses" }),
    });
    expect(res.status).toBe(404);
  });
});
