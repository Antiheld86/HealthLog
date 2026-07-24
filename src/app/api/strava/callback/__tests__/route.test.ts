/**
 * S-1 — the Strava OAuth callback enqueues the self-converging history backfill
 * at connect time (mirroring the WHOOP / Fitbit callbacks) so deep history
 * lands within the hour instead of waiting for the next worker reboot. A missing
 * boss instance is a warning, never a failure — boot discovery is the net.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  bossSend,
  getGlobalBossMock,
  exchangeCodeMock,
  getCredsMock,
  userFindUnique,
  userUpdate,
  markReconnectedMock,
} = vi.hoisted(() => ({
  bossSend: vi.fn(async () => "job-id"),
  getGlobalBossMock: vi.fn(),
  exchangeCodeMock: vi.fn(),
  getCredsMock: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(async () => ({})),
  markReconnectedMock: vi.fn(async () => {}),
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: userFindUnique, update: userUpdate } },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn(async () => null) }));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({
    setAuth: vi.fn(),
    setError: vi.fn(),
    addWarning: vi.fn(),
  }),
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn(async () => {}) }));
vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => `enc(${s})` }));
vi.mock("@/lib/strava/client", () => ({ exchangeCode: exchangeCodeMock }));
vi.mock("@/lib/strava/credentials", () => ({
  getStravaClientCredentials: getCredsMock,
}));
vi.mock("@/lib/oauth/signed-state", () => ({
  oauthStateCookieName: () => "strava_oauth_state",
  stateMatchesCookie: () => true,
  verifySignedState: () => ({ userId: "u1" }),
}));
vi.mock("@/lib/integrations/status", () => ({
  markReconnected: markReconnectedMock,
}));
vi.mock("@/lib/jobs/strava-backfill", () => ({
  STRAVA_BACKFILL_QUEUE: "strava-backfill",
}));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: getGlobalBossMock,
}));

import { GET } from "../route";

process.env.NEXT_PUBLIC_APP_URL = "https://app.example";

function callback(): Promise<{ headers: { get(k: string): string | null } }> {
  const req = new NextRequest(
    "http://localhost/api/strava/callback?code=abc&state=signed-state",
    { headers: { cookie: "strava_oauth_state=signed-state" } },
  );
  return (GET as unknown as (r: NextRequest) => Promise<never>)(req);
}

beforeEach(() => {
  vi.clearAllMocks();
  getCredsMock.mockResolvedValue({ clientId: "c", clientSecret: "s" });
  exchangeCodeMock.mockResolvedValue({
    access_token: "at",
    refresh_token: "rt",
    athlete: { id: 42 },
  });
  userFindUnique.mockResolvedValue({ stravaAthleteId: null });
  getGlobalBossMock.mockReturnValue({ send: bossSend });
});

describe("GET /api/strava/callback — S-1 backfill enqueue", () => {
  it("enqueues one STRAVA_BACKFILL_QUEUE job for the connecting user", async () => {
    const res = await callback();

    expect(res.headers.get("location")).toContain("strava=connected");
    expect(markReconnectedMock).toHaveBeenCalledWith("u1", "strava");
    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(bossSend).toHaveBeenCalledWith(
      "strava-backfill",
      expect.objectContaining({ userId: "u1" }),
    );
  });

  it("still connects when the boss instance is unavailable (warning, not failure)", async () => {
    getGlobalBossMock.mockReturnValue(null);

    const res = await callback();

    expect(res.headers.get("location")).toContain("strava=connected");
    expect(bossSend).not.toHaveBeenCalled();
  });
});
