/**
 * Authorize endpoint — consent gate + audience + PKCE + redirect-URI binding.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.API_TOKEN_HMAC_KEY = "x".repeat(48);
process.env.APP_URL = "https://health.example";

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: (_n: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 60_000,
    ip: "1.2.3.4",
  })),
  rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/app-settings", () => ({
  isApiGloballyEnabled: vi.fn(async () => true),
}));

import { GET, POST } from "../authorize/route";
import { getSession } from "@/lib/auth/session";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { registerDcrClient } from "@/lib/mcp/oauth/clients";
import { s256Challenge } from "@/lib/mcp/oauth/pkce";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(64);
const CHALLENGE = s256Challenge(VERIFIER);
const RESOURCE = "https://health.example/mcp";

const CLIENT = registerDcrClient({
  clientName: "Claude",
  redirectUris: [REDIRECT],
});

function authorizeUrl(
  overrides: Record<string, string | undefined> = {},
): string {
  const params: Record<string, string | undefined> = {
    response_type: "code",
    client_id: CLIENT.clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "health:read",
    state: "xyz",
    resource: RESOURCE,
    ...overrides,
  };
  const u = new URL("https://health.example/api/mcp/oauth/authorize");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.searchParams.set(k, v);
  }
  return u.toString();
}

function getReq(url: string): Request {
  return new Request(url, { method: "GET" });
}

function postReq(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request("https://health.example/api/mcp/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

function signedIn() {
  vi.mocked(getSession).mockResolvedValue({
    session: {
      id: "s1",
      expiresAt: new Date(Date.now() + 1e6),
      actingAsUserId: null,
      recordEpoch: 0,
    },
    user: { id: "user-1" } as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(null);
  vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);
});

describe("GET /authorize — consent gate", () => {
  it("renders a consent screen for an authenticated user (no code issued)", async () => {
    signedIn();
    const res = await GET(getReq(authorizeUrl()) as never);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/Authorize access/);
    expect(body).toMatch(/Claude/);
    expect(body).toMatch(/decision/); // the Allow/Deny form
    // A GET never mints a code.
    expect(body).not.toMatch(/hlac_/);
  });

  it("prompts sign-in (with a return link) when there is no session", async () => {
    const res = await GET(getReq(authorizeUrl()) as never);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/\/auth\/login/);
    expect(body).not.toMatch(/hlac_/);
  });
});

describe("GET /authorize — rejected requests", () => {
  it("rejects an audience mismatch with 400 invalid_target", async () => {
    signedIn();
    const res = await GET(
      getReq(authorizeUrl({ resource: "https://evil.example/mcp" })) as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_target");
  });

  it("rejects a missing PKCE challenge with 400", async () => {
    signedIn();
    const res = await GET(
      getReq(
        authorizeUrl({
          code_challenge: undefined,
          code_challenge_method: undefined,
        }),
      ) as never,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-S256 PKCE method with 400", async () => {
    signedIn();
    const res = await GET(
      getReq(authorizeUrl({ code_challenge_method: "plain" })) as never,
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown client with 400 invalid_client", async () => {
    signedIn();
    const res = await GET(
      getReq(authorizeUrl({ client_id: "bogus" })) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client");
  });

  it("rejects a redirect_uri not registered to the client", async () => {
    signedIn();
    const res = await GET(
      getReq(
        authorizeUrl({ redirect_uri: "https://evil.example/cb" }),
      ) as never,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /authorize — consent provenance (L1)", () => {
  it("labels a DCR client as unverified (self-asserted name)", async () => {
    signedIn();
    const res = await GET(getReq(authorizeUrl()) as never);
    const body = await res.text();
    expect(body).toMatch(/Unverified application/);
  });
});

describe("authorize — surface availability (M1/M4)", () => {
  it("GET returns 503 when the API is globally disabled", async () => {
    signedIn();
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(false);
    const res = await GET(getReq(authorizeUrl()) as never);
    expect(res.status).toBe(503);
  });

  it("POST returns 503 when the API is globally disabled", async () => {
    signedIn();
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(false);
    const res = await POST(
      postReq({
        response_type: "code",
        client_id: CLIENT.clientId,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        scope: "health:read",
        resource: RESOURCE,
        decision: "allow",
      }) as never,
    );
    expect(res.status).toBe(503);
  });
});

describe("POST /authorize — cross-origin guard (L3)", () => {
  it("rejects a cross-origin Origin with 403", async () => {
    signedIn();
    const body = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT.clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      scope: "health:read",
      resource: RESOURCE,
      decision: "allow",
    });
    const req = new Request("https://health.example/api/mcp/oauth/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body: body.toString(),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(403);
  });

  it("rejects a cross-site Sec-Fetch-Site with 403", async () => {
    signedIn();
    const body = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT.clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      scope: "health:read",
      resource: RESOURCE,
      decision: "allow",
    });
    const req = new Request("https://health.example/api/mcp/oauth/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
      body: body.toString(),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(403);
  });
});

describe("POST /authorize — decision", () => {
  it("requires a session (401 when unauthenticated)", async () => {
    const res = await POST(
      postReq({
        response_type: "code",
        client_id: CLIENT.clientId,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        scope: "health:read",
        resource: RESOURCE,
        decision: "allow",
      }) as never,
    );
    expect(res.status).toBe(401);
  });

  it("mints a code and 302s back on allow", async () => {
    signedIn();
    const res = await POST(
      postReq({
        response_type: "code",
        client_id: CLIENT.clientId,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        scope: "health:read",
        state: "xyz",
        resource: RESOURCE,
        decision: "allow",
      }) as never,
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const code = new URL(loc).searchParams.get("code");
    expect(code).toMatch(/^hlac_/);
    expect(new URL(loc).searchParams.get("state")).toBe("xyz");
    // RFC 9207 — the issuer identifier is echoed on the success redirect.
    expect(new URL(loc).searchParams.get("iss")).toBe("https://health.example");
  });

  it("302s with access_denied on deny", async () => {
    signedIn();
    const res = await POST(
      postReq({
        response_type: "code",
        client_id: CLIENT.clientId,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        scope: "health:read",
        resource: RESOURCE,
        decision: "deny",
      }) as never,
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(new URL(loc).searchParams.get("error")).toBe("access_denied");
    // RFC 9207 — the issuer is echoed on the error redirect too.
    expect(new URL(loc).searchParams.get("iss")).toBe("https://health.example");
  });
});
