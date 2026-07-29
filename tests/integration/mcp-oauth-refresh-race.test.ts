/**
 * MCP OAuth refresh-family safety against real PostgreSQL.
 *
 * The race test deliberately holds the connection row in a separate database
 * transaction until both token exchanges are waiting on that row. Releasing
 * the lock gives the two exchanges the same deterministic start point without
 * replacing concurrency or persistence with mocks.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { hashToken } from "@/lib/auth/hmac";
import { issueApiToken } from "@/lib/auth/issue-token";
import { resolveBearerToken } from "@/lib/auth/bearer";
import { signArtifact } from "@/lib/mcp/oauth/artifacts";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.APP_URL = "https://health.example";

const CLIENT_ID = "https://connector.example/client.json";
const RESOURCE = "https://health.example/mcp";
const SCOPE = "health:read offline_access";

interface SeededConnection {
  connectionId: string;
  refreshToken: string;
}

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  error?: string;
}

function tokenRequest(refreshToken: string): Request {
  return new Request("https://health.example/api/mcp/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": "203.0.113.42",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
}

async function exchange(refreshToken: string): Promise<Response> {
  const { POST } = await import("@/app/api/mcp/oauth/token/route");
  return POST(tokenRequest(refreshToken) as never);
}

async function seedConnection(label: string): Promise<SeededConnection> {
  const prisma = getPrismaClient();
  const userId = `mcp-refresh-${label}`;
  const jti = `jti-${label}`;

  await prisma.user.create({
    data: {
      id: userId,
      username: userId,
      email: `${userId}@example.test`,
      timezone: "UTC",
    },
  });
  const connection = await prisma.mcpOAuthConnection.create({
    data: {
      userId,
      clientId: CLIENT_ID,
      clientName: `Connector ${label}`,
      scope: SCOPE,
      resource: RESOURCE,
      currentJti: jti,
    },
  });

  // Every family starts with a real linked access row. Rotation must revoke it,
  // and replay-family revocation must cover every later linked successor too.
  await issueApiToken({
    userId,
    name: `Initial access ${label}`,
    permissions: ["health:read"],
    expiresInMinutes: 60,
    mcpConnectionId: connection.id,
  });

  return {
    connectionId: connection.id,
    refreshToken: signArtifact(
      "refreshToken",
      {
        jti,
        cid: connection.id,
        sub: userId,
        client_id: CLIENT_ID,
        scope: SCOPE,
        resource: RESOURCE,
      },
      60 * 60 * 1000,
    ),
  };
}

async function waitForBlockedConnectionExchanges(
  expected: number,
): Promise<void> {
  const prisma = getPrismaClient();
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
      SELECT count(*)::bigint AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%mcp_oauth_connections%'
    `;
    if (Number(rows[0]?.waiting ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(
    `Timed out waiting for ${expected} refresh exchanges at the database barrier`,
  );
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("MCP OAuth refresh rotation (real PostgreSQL)", () => {
  it("keeps an ordinary single-client rotation usable", async () => {
    const seeded = await seedConnection("sequential");

    const first = await exchange(seeded.refreshToken);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as TokenBody;
    expect(firstBody.access_token).toMatch(/^hlk_/);
    expect(firstBody.refresh_token).toMatch(/^hlrt_/);

    await expect(
      resolveBearerToken(firstBody.access_token!, {
        kind: "scope",
        scope: "health:read",
      }),
    ).resolves.toMatchObject({
      user: { id: "mcp-refresh-sequential" },
      permissions: ["health:read"],
    });

    const second = await exchange(firstBody.refresh_token!);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as TokenBody;
    await expect(
      resolveBearerToken(secondBody.access_token!, {
        kind: "scope",
        scope: "health:read",
      }),
    ).resolves.toMatchObject({
      user: { id: "mcp-refresh-sequential" },
    });
  });

  it("revokes the whole raced family and every returned successor without harming another connection", async () => {
    const prisma = getPrismaClient();
    const raced = await seedConnection("raced");
    const unrelated = await seedConnection("unrelated");

    let releaseLock!: () => void;
    let markLocked!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });

    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id
          FROM mcp_oauth_connections
          WHERE id = ${raced.connectionId}
          FOR UPDATE
        `;
        markLocked();
        await release;
      },
      { timeout: 20_000 },
    );

    await locked;
    const contenders = [
      exchange(raced.refreshToken),
      exchange(raced.refreshToken),
    ];

    try {
      await waitForBlockedConnectionExchanges(2);
    } finally {
      releaseLock();
      await blocker;
    }

    const responses = await Promise.all(contenders);
    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<TokenBody>),
    );
    const returnedSuccessors = bodies.filter(
      (body): body is Required<
        Pick<TokenBody, "access_token" | "refresh_token">
      > =>
        typeof body.access_token === "string" &&
        typeof body.refresh_token === "string",
    );

    // The current implementation has one CAS winner and one loser. A secure
    // implementation may also reject both, but it may never leave a returned
    // winner usable once the simultaneous replay has been observed.
    expect(
      responses.filter((response) => response.status === 400).length,
    ).toBeGreaterThanOrEqual(1);
    expect(returnedSuccessors.length).toBeLessThanOrEqual(1);

    for (const successor of returnedSuccessors) {
      let accessUsable = true;
      try {
        await resolveBearerToken(successor.access_token, {
          kind: "scope",
          scope: "health:read",
        });
      } catch {
        accessUsable = false;
      }
      expect.soft(accessUsable, "raced access successor survived").toBe(false);

      const refreshResult = await exchange(successor.refresh_token);
      expect
        .soft(refreshResult.status, "raced refresh successor survived")
        .toBe(400);
    }

    const racedRow = await prisma.mcpOAuthConnection.findUniqueOrThrow({
      where: { id: raced.connectionId },
    });
    expect
      .soft(racedRow.revokedAt, "raced connection was not revoked")
      .toBeInstanceOf(Date);

    const racedAccessRows = await prisma.apiToken.findMany({
      where: { mcpConnectionId: raced.connectionId },
      select: { tokenHash: true, revoked: true },
    });
    expect(racedAccessRows.length).toBeGreaterThan(0);
    expect
      .soft(
        racedAccessRows.every((row) => row.revoked),
        "a linked access successor remained live",
      )
      .toBe(true);

    // Cross-family safety: an unrelated connection still rotates, and its
    // returned access token resolves through the ordinary bearer verifier.
    const unrelatedResult = await exchange(unrelated.refreshToken);
    expect(unrelatedResult.status).toBe(200);
    const unrelatedBody = (await unrelatedResult.json()) as TokenBody;
    await expect(
      resolveBearerToken(unrelatedBody.access_token!, {
        kind: "scope",
        scope: "health:read",
      }),
    ).resolves.toMatchObject({
      user: { id: "mcp-refresh-unrelated" },
    });

    // No plaintext credential is persisted; this also makes the post-race
    // verifier assertion use the same HMAC lookup the product uses.
    expect(
      racedAccessRows.some(
        (row) =>
          returnedSuccessors[0]?.access_token &&
          row.tokenHash === hashToken(returnedSuccessors[0].access_token),
      ),
    ).toBe(returnedSuccessors.length === 1);
  });
});
