/**
 * `DELETE /api/strava/credentials` — the teardown always leaves a trail.
 *
 * The audit row and the ledger park used to run only when an access token
 * happened to be present, so removing a stored credential pair that had never
 * completed OAuth was invisible afterwards: no audit row, and a ledger left at
 * whatever state it last held. The Polar twin has always done both
 * unconditionally. Strava had no test file at all, which is why this one
 * exists.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/integrations/status", () => ({ markDisconnected: vi.fn() }));

const { storeMock, clearMock } = vi.hoisted(() => ({
  storeMock: vi.fn(),
  clearMock: vi.fn(),
}));
vi.mock("@/lib/strava/credentials", () => ({
  storeStravaClientCredentials: storeMock,
  clearStravaClientCredentials: clearMock,
}));

vi.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
  apiError: (error: string, status: number) => ({ data: null, error, status }),
  safeJson: vi.fn(),
}));

import { DELETE } from "../route";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { markDisconnected } from "@/lib/integrations/status";

const userFind = prisma.user.findUnique as ReturnType<typeof vi.fn>;
const userUpdate = prisma.user.update as ReturnType<typeof vi.fn>;

type RouteResult = { data: unknown; error: string | null; status: number };

beforeEach(() => {
  vi.clearAllMocks();
  userFind.mockResolvedValue(null);
  userUpdate.mockResolvedValue({});
  clearMock.mockResolvedValue(undefined);
});

describe("DELETE /api/strava/credentials", () => {
  const del = DELETE as unknown as () => Promise<RouteResult>;

  it("audits + marks disconnected when a live token was present", async () => {
    userFind.mockResolvedValue({ stravaAccessTokenEncrypted: "enc:tok" });
    const res = await del();
    expect(res.data).toEqual({ deleted: true });
    expect(clearMock).toHaveBeenCalledWith("u1");
    expect(auditLog).toHaveBeenCalledWith("strava.credentials.delete", {
      userId: "u1",
    });
    expect(markDisconnected).toHaveBeenCalledWith("u1", "strava");
  });

  it("audits + marks disconnected even when nothing was connected", async () => {
    userFind.mockResolvedValue({ stravaAccessTokenEncrypted: null });
    const res = await del();
    expect(res.data).toEqual({ deleted: true });
    expect(clearMock).toHaveBeenCalledWith("u1");
    expect(auditLog).toHaveBeenCalledWith("strava.credentials.delete", {
      userId: "u1",
    });
    expect(markDisconnected).toHaveBeenCalledWith("u1", "strava");
  });

  it("clears the athlete id alongside both tokens", async () => {
    await del();
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          stravaAccessTokenEncrypted: null,
          stravaRefreshTokenEncrypted: null,
          stravaAthleteId: null,
        },
      }),
    );
  });
});
