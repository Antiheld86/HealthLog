/**
 * Behavioural suite for the fail-closed Bearer-scope default, against a real
 * Postgres and the real resolver — no mocked Prisma, no mocked `requireAuth`.
 *
 * The gap this pins: `requireAuth()` enforced a token's scope only when the
 * route passed one, and 324 of 330 route files pass none. A token minted for
 * medication intake therefore reached the full-backup export, the labs surface,
 * the coach, and the bulk deletes. B1 is the direct regression test — it fails
 * on the pre-fix tree.
 *
 * Seven cases against 300-odd routes prove nothing about the other routes by
 * enumeration. The guarantee for those is structural (one resolution path, one
 * authorisation arm) and is held by
 * `src/__tests__/bearer-scope-enforcement-guard.test.ts`. What these cases do
 * is prove the arm itself behaves, end to end, for every credential shape the
 * app actually mints.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-bearer-scope-enforcement-32-bytes-min-0987654321";

const { hashToken } = await import("@/lib/auth/hmac");

const USER_ID = "user-bearer-scope-test";
const MCP_RESOURCE = "https://health.example/mcp";
process.env.APP_URL = "https://health.example";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "bearer-scope",
      email: "bearer-scope@example.test",
      timezone: "UTC",
      modulePreferencesJson: { mcp: true },
    },
  });
});

/** Mint a real `ApiToken` row with the given scopes and arm the Bearer header. */
async function armToken(permissions: string[], label = "t"): Promise<string> {
  const raw = `hlk_${label}_${"0".repeat(48)}`;
  await getPrismaClient().apiToken.create({
    data: {
      userId: USER_ID,
      name: label,
      tokenHash: hashToken(raw),
      permissions,
    },
  });
  headerJar.set("authorization", `Bearer ${raw}`);
  return raw;
}

async function armExpiringToken(
  permissions: string[],
  label: string,
  state: { expiresAt?: Date; revoked?: boolean } = {},
): Promise<string> {
  const raw = await armToken(permissions, label);
  await getPrismaClient().apiToken.update({
    where: { tokenHash: hashToken(raw) },
    data: state,
  });
  return raw;
}

function mcpReq(
  rawToken: string,
  method: "initialize" | "tools/list" | "tools/call",
  params?: Record<string, unknown>,
): Request {
  return new Request(MCP_RESOURCE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${rawToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params ? { params } : {}),
    }),
  });
}

/** Arm a real cookie session instead of a Bearer token. */
async function useCookieSession(): Promise<void> {
  const session = await getPrismaClient().session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

function req(path: string, method = "GET"): NextRequest {
  const init: RequestInit = { method };
  const raw = headerJar.get("authorization");
  if (raw) init.headers = { authorization: raw };
  return new NextRequest(`https://health.example${path}`, init as never);
}

/** The most recent `auth.bearer.failure` audit row's machine reason. */
async function lastBearerFailureReason(): Promise<string | undefined> {
  const row = await getPrismaClient().auditLog.findFirst({
    where: { action: "auth.bearer.failure" },
    orderBy: { createdAt: "desc" },
  });
  if (!row?.details) return undefined;
  return (JSON.parse(row.details) as { reason?: string }).reason;
}

describe("B1 — a narrow token cannot read the full-account export", () => {
  it("refuses ['medication:ingest'] on GET /api/export/full-backup with 403", async () => {
    // The vulnerability in one request: this is the token the settings card
    // told users to hand to third-party automations, reading every row the
    // account holds.
    await armToken(["medication:ingest"], "narrow");
    const { GET } = await import("@/app/api/export/full-backup/route");

    const res = await GET(req("/api/export/full-backup"));

    expect(res.status).toBe(403);
    const json = (await res.json()) as { data: null; error: string };
    expect(json.data).toBeNull();
    expect(json.error).toBe("Insufficient permissions");

    // The break is visible AND attributable: an operator can name the token.
    // The audit write is fire-and-forget — poll for the value instead of
    // sleeping a fixed span and hoping the runner was fast enough; on
    // timeout the poll asserts against what WAS written.
    await expect
      .poll(() => lastBearerFailureReason(), { timeout: 5_000, interval: 100 })
      .toBe("undeclared_scope");
  });

  it("refuses the same token on GET /api/labs with 403", async () => {
    await armToken(["medication:ingest"], "narrow2");
    const { GET } = await import("@/app/api/labs/route");
    const res = await GET(req("/api/labs"));
    expect(res.status).toBe(403);
  });
});

describe("B2/B3 — the medication-ingest surface is unchanged", () => {
  async function seedMedication(): Promise<string> {
    const med = await getPrismaClient().medication.create({
      data: { userId: USER_ID, name: "Test Med", dose: "1 mg" },
    });
    return med.id;
  }

  it("B2 — the per-medication token still ingests", async () => {
    // The credential that actually performs medication intake. It never
    // touches `requireAuth` — `/api/ingest/medication` hand-rolls the whole
    // resolution — so the fail-closed default cannot reach it. This is the
    // one flow a fail-closed default could plausibly have broken.
    const medId = await seedMedication();
    await armToken(["medication:ingest", `medication:${medId}:ingest`], "pair");
    const { POST } = await import("@/app/api/ingest/medication/route");

    const request = new NextRequest(
      "https://health.example/api/ingest/medication",
      {
        method: "POST",
        headers: {
          authorization: headerJar.get("authorization")!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          medicationName: "Test Med",
          idempotencyKey: "bearer-scope-b2",
        }),
      } as never,
    );
    const res = await POST(request);

    expect([200, 201]).toContain(res.status);
    const events = await getPrismaClient().medicationIntakeEvent.count({
      where: { userId: USER_ID },
    });
    expect(events).toBe(1);
  });

  it("B3 — a token without the per-medication grant is still refused", async () => {
    // The pre-existing second gate. This is why the retired `/api/tokens`
    // mint never worked for its advertised purpose.
    await seedMedication();
    await armToken(["medication:ingest"], "familyonly");
    const { POST } = await import("@/app/api/ingest/medication/route");

    const request = new NextRequest(
      "https://health.example/api/ingest/medication",
      {
        method: "POST",
        headers: {
          authorization: headerJar.get("authorization")!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          medicationName: "Test Med",
          idempotencyKey: "bearer-scope-b3",
        }),
      } as never,
    );
    const res = await POST(request);

    expect(res.status).toBe(403);
  });
});

describe("B4 — the native client is not broken", () => {
  it("admits a ['*'] token on GET /api/export/full-backup", async () => {
    // Login, passkey login-verify and refresh rotation all mint `["*"]`, so
    // this is exactly the credential the iOS app holds. If this case ever
    // goes red, the native client is down.
    await armToken(["*"], "wildcard");
    const { GET } = await import("@/app/api/export/full-backup/route");
    const res = await GET(req("/api/export/full-backup"));
    expect(res.status).toBe(200);
  });

  it("admits a ['*'] token on a batch ingest route", async () => {
    await armToken(["*"], "wildcardbatch");
    const { POST } = await import("@/app/api/measurements/batch/route");
    const request = new NextRequest(
      "https://health.example/api/measurements/batch",
      {
        method: "POST",
        headers: {
          authorization: headerJar.get("authorization")!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
              value: 70,
              unit: "kg",
              startDate: new Date().toISOString(),
              endDate: new Date().toISOString(),
              externalId: "uuid-bearer-scope-1",
            },
          ],
        }),
      } as never,
    );
    const res = await POST(request);
    expect(res.status).toBe(200);
  });
});

describe("B5 — an MCP token is audience-bound to /mcp", () => {
  it("refuses ['health:read'] on a REST read", async () => {
    // Narrowing, not breakage: the token's REST read leg was never a feature
    // an MCP client used. Its audience is now /mcp alone.
    await armToken(["health:read"], "mcpread");
    const { GET } = await import("@/app/api/export/full-backup/route");
    const res = await GET(req("/api/export/full-backup"));
    expect(res.status).toBe(403);
  });

  it("still resolves the same token on the /mcp wire", async () => {
    const raw = await armToken(["health:read"], "mcpread2");
    const { resolveMcpAuthContext } = await import("@/lib/mcp/auth");

    const ctx = await resolveMcpAuthContext(raw);

    expect(ctx.userId).toBe(USER_ID);
    expect(ctx.canRead).toBe(true);
    // Read-only token: the write tools stay shut.
    expect(ctx.canWrite).toBe(false);
  });

  it("grants write on /mcp only for a consented health:write token", async () => {
    const raw = await armToken(["health:read", "health:write"], "mcprw");
    const { resolveMcpAuthContext } = await import("@/lib/mcp/auth");
    const ctx = await resolveMcpAuthContext(raw);
    expect(ctx.canWrite).toBe(true);
  });
});

describe("B5b — MCP health reads require an explicit read grant", () => {
  async function postMcp(
    rawToken: string,
    method: "initialize" | "tools/list" | "tools/call",
    params?: Record<string, unknown>,
  ): Promise<Response> {
    const { POST } = await import("@/app/mcp/route");
    return POST(mcpReq(rawToken, method, params));
  }

  it.each([
    ["health:read", ["health:read"]],
    ["wildcard", ["*"]],
  ])("admits %s through capability registration", async (_label, scopes) => {
    const raw = await armToken(scopes, `mcp-positive-${_label}`);

    const res = await postMcp(raw, "tools/list");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name)).toContain("get_labs");
  });

  it.each([
    ["medication ingest", ["medication:ingest"]],
    ["notifications", ["notifications:send"]],
    ["FHIR", ["fhir:read"]],
    ["write-only", ["health:write"]],
    ["unrelated", ["profile:read"]],
  ])(
    "denies a same-user %s token before a real lab read",
    async (_label, scopes) => {
      const raw = await armToken(scopes, `mcp-negative-${_label}`);
      await getPrismaClient().labResult.create({
        data: {
          userId: USER_ID,
          analyte: "LDL",
          value: 177,
          unit: "mg/dL",
          takenAt: new Date("2026-07-20T08:00:00.000Z"),
        },
      });

      const res = await postMcp(raw, "tools/call", {
        name: "get_labs",
        arguments: {},
      });

      expect([401, 403]).toContain(res.status);
      expect(await res.text()).not.toContain("177");
    },
  );

  it.each([
    ["expired", { expiresAt: new Date("2020-01-01T00:00:00.000Z") }],
    ["revoked", { revoked: true }],
  ])(
    "denies an explicit but %s health:read credential",
    async (_label, state) => {
      const raw = await armExpiringToken(
        ["health:read"],
        `mcp-${_label}`,
        state,
      );

      const res = await postMcp(raw, "tools/list");

      expect([401, 403]).toContain(res.status);
    },
  );
});

describe("B6 — a declared scope grants only what it names", () => {
  it("admits ['fhir:read'] on the FHIR face", async () => {
    await armToken(["fhir:read"], "fhir");
    const { GET } = await import("@/app/api/fhir/Observation/route");
    const res = await GET(req("/api/fhir/Observation"));
    expect(res.status).toBe(200);
  });

  it("refuses the same token on /api/labs, which declares no scope", async () => {
    // The whole point of the inversion: holding a scope buys the routes that
    // name it, and nothing else.
    await armToken(["fhir:read"], "fhir2");
    const { GET } = await import("@/app/api/labs/route");
    const res = await GET(req("/api/labs"));
    expect(res.status).toBe(403);
  });
});

describe("B7 — cookie sessions are untouched", () => {
  it("reaches every route the narrow token was refused on", async () => {
    await useCookieSession();

    const backup = await import("@/app/api/export/full-backup/route");
    expect((await backup.GET(req("/api/export/full-backup"))).status).toBe(200);

    const labs = await import("@/app/api/labs/route");
    expect((await labs.GET(req("/api/labs"))).status).toBe(200);

    const fhir = await import("@/app/api/fhir/Observation/route");
    expect((await fhir.GET(req("/api/fhir/Observation"))).status).toBe(200);
  });

  it("requireAdmin still refuses a ['*'] Bearer token", async () => {
    // The cookie-only property of `requireAdmin()` is orthogonal to this
    // change and must stay orthogonal. A wildcard token is the strongest
    // Bearer credential the app mints and it still cannot elevate.
    await getPrismaClient().user.update({
      where: { id: USER_ID },
      data: { role: "ADMIN" },
    });
    await armToken(["*"], "adminwild");

    const { requireAdmin, HttpError } = await import("@/lib/api-handler");
    await expect(requireAdmin()).rejects.toBeInstanceOf(HttpError);
  });
});
