/**
 * `/api/tokens` — the instance-wide API switch must not hide live credentials.
 *
 * `AppSettings.apiGlobal` gates the surfaces a token is FOR — external
 * medication ingest, the MCP bridge — and not a token's ability to
 * authenticate: nothing on the `requireAuth` path consults it, which the last
 * case here asserts directly rather than assuming. So a token minted before an
 * operator flipped the switch stays a live credential while it is off, and the
 * LIST used to answer 403 — hiding exactly the credentials their owner most
 * needed to see, including the wildcard access token their own phone signs in
 * with.
 *
 * The read is ungated now. The revoke is not, and that asymmetry is pinned
 * below rather than left to drift: it is a decision about what the switch
 * means, and a change to it should be a visible diff here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (fn: unknown) => fn,
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

vi.mock("@/lib/app-settings", () => ({ isApiGloballyEnabled: vi.fn() }));

import { GET } from "../route";
import { DELETE } from "../[id]/route";
import { requireAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { isApiGloballyEnabled } from "@/lib/app-settings";

const USER = { id: "user-1", username: "u" };

const ROW = {
  id: "tok-1",
  name: "iPhone",
  permissions: ["*"],
  lastUsedAt: new Date("2026-08-01T10:00:00Z"),
  expiresAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  revoked: false,
};

type ListEnvelope = {
  data: Array<{ id: string }> | null;
  error: string | null;
};

const params = Promise.resolve({ id: "tok-1" });

type DeleteHandler = (
  r: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({ user: USER } as never);
  vi.mocked(prisma.apiToken.findMany).mockResolvedValue([ROW] as never);
});

describe("GET /api/tokens", () => {
  it("lists the caller's tokens while the operator has the API switched off", async () => {
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(false);

    const res = await (GET as unknown as () => Promise<Response>)();

    expect(res.status).toBe(200);
    const env = (await res.json()) as ListEnvelope;
    expect(env.error).toBeNull();
    expect(env.data?.[0]?.id).toBe("tok-1");
    expect(prisma.apiToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER.id } }),
    );
  });

  it("does not consult the switch at all", async () => {
    // Stronger than the status assertion above and the reason it is separate:
    // a future re-gating that happened to answer 200 anyway would still be a
    // read whose behaviour depends on an operator toggle it has no business
    // reading.
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(false);

    await (GET as unknown as () => Promise<Response>)();

    expect(isApiGloballyEnabled).not.toHaveBeenCalled();
  });

  it("still scopes the list to the caller", async () => {
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);

    await (GET as unknown as () => Promise<Response>)();

    const args = vi.mocked(prisma.apiToken.findMany).mock.calls[0][0];
    expect(args?.where).toEqual({ userId: USER.id });
    // No `revoked: false` filter — revoked rows stay in the list, which is
    // what the published contract says and what the UI relies on.
    expect(JSON.stringify(args?.where)).not.toContain("revoked");
  });
});

describe("DELETE /api/tokens/{id}", () => {
  it("keeps refusing while the operator has the API switched off", async () => {
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(false);

    const res = await (DELETE as unknown as DeleteHandler)(
      new Request("http://localhost/api/tokens/tok-1", { method: "DELETE" }),
      { params },
    );

    expect(res.status).toBe(403);
    expect(prisma.apiToken.update).not.toHaveBeenCalled();
  });

  it("revokes when the switch is on", async () => {
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      ...ROW,
      userId: USER.id,
    } as never);
    vi.mocked(prisma.apiToken.update).mockResolvedValue({} as never);

    const res = await (DELETE as unknown as DeleteHandler)(
      new Request("http://localhost/api/tokens/tok-1", { method: "DELETE" }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(prisma.apiToken.update).toHaveBeenCalledWith({
      where: { id: "tok-1" },
      data: { revoked: true },
    });
  });

  it("does not reach another account's token", async () => {
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      ...ROW,
      userId: "someone-else",
    } as never);

    const res = await (DELETE as unknown as DeleteHandler)(
      new Request("http://localhost/api/tokens/tok-1", { method: "DELETE" }),
      { params },
    );

    expect(res.status).toBe(404);
    expect(prisma.apiToken.update).not.toHaveBeenCalled();
  });
});

describe("the switch and the authentication path", () => {
  it("is not consulted by requireAuth, which is why the read must not gate on it", async () => {
    // The premise the fix rests on, asserted rather than assumed: if the auth
    // kit ever started refusing Bearer callers while `apiGlobal` is off, then
    // a token would NOT be live during the outage and hiding the list would
    // stop being wrong. This reads the source because the behaviour is an
    // absence, and an absence has no call to spy on.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "src/lib/api-handler.ts"),
      "utf8",
    );
    expect(source).not.toContain("isApiGloballyEnabled");
    expect(source).not.toContain("apiGlobal");
  });
});
