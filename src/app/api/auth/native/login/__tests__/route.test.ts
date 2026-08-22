/**
 * GET /api/auth/native/login — authorize entry (iOS #65).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

process.env.ENCRYPTION_KEY = "0".repeat(64);

vi.mock("@/lib/api-handler", () => ({ apiHandler: (fn: unknown) => fn }));

vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn(),
}));

// Only `$queryRaw` (the DB clock) is used here; return a fixed instant.
// Hoisted so the mock factory (also hoisted) can reference it.
const { DB_NOW } = vi.hoisted(() => ({
  DB_NOW: new Date("2026-07-24T10:00:00.000Z"),
}));
vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: vi.fn().mockResolvedValue([{ now: DB_NOW }]) },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { GET } from "../route";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import {
  NATIVE_HANDOFF_STATE_COOKIE,
  decodeNativeHandoffState,
} from "@/lib/auth/native-web-handoff";

const VALID_CHALLENGE = "a".repeat(43);

function req(query = `code_challenge=${VALID_CHALLENGE}`): NextRequest {
  return new NextRequest(`http://localhost/api/auth/native/login?${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    ip: "1.2.3.4",
  } as never);
});

describe("GET /api/auth/native/login", () => {
  it("valid challenge → 302 to the web login page with flow=native + state cookie", async () => {
    const res = await GET(req());
    const location = res.headers.get("location")!;
    // Exact, not `toContain`. The looser form was what let iOS #96 ship: it is
    // satisfied by "http://0.0.0.0:3000/auth/login?flow=native" just as
    // happily, so it asserted the path was in there rather than that a host
    // was not.
    expect(location).toBe("/auth/login?flow=native");
    // No custom scheme on the success path.
    expect(location.startsWith("healthlog://")).toBe(false);

    const cookie = res.cookies.get(NATIVE_HANDOFF_STATE_COOKIE);
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.path).toBe("/api/auth/native");
    expect(cookie?.httpOnly).toBe(true);

    // The state round-trips: challenge bound, startedAt is the DB clock.
    const state = decodeNativeHandoffState(cookie!.value);
    expect(state?.appCodeChallenge).toBe(VALID_CHALLENGE);
    expect(state?.startedAt).toBe(DB_NOW.toISOString());
  });

  it("invalid (short) challenge → scheme error, no state cookie", async () => {
    const res = await GET(req("code_challenge=tooshort"));
    expect(res.headers.get("location")).toBe(
      "healthlog://login-callback?error=invalid_request",
    );
    expect(res.cookies.get(NATIVE_HANDOFF_STATE_COOKIE)?.value).toBeFalsy();
    // No DB clock read on the reject path.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("missing challenge → scheme error", async () => {
    const res = await GET(req(""));
    expect(res.headers.get("location")).toBe(
      "healthlog://login-callback?error=invalid_request",
    );
  });

  it("behind a proxy that drops Host, the redirect still points at the caller's origin", async () => {
    // What a proxy hop looks like from inside the handler: the request the
    // route sees names the address the Node process bound to, because the
    // public Host header never made it through. Building the redirect out of
    // that URL is how iOS #96 happened, and `ASWebAuthenticationSession`
    // refuses the resulting address outright.
    //
    // Every other test in this file builds `http://localhost/...`, where the
    // host is harmless and the absolute URL looked correct. That is why the
    // route shipped broken.
    const res = await GET(
      new NextRequest(
        `http://0.0.0.0:3000/api/auth/native/login?code_challenge=${VALID_CHALLENGE}`,
      ),
    );

    const location = res.headers.get("location")!;
    expect(location).toBe("/auth/login?flow=native");
    expect(
      location,
      "a relative Location resolves against the address the client actually called",
    ).not.toMatch(/^https?:\/\//);
    expect(location).not.toContain("0.0.0.0");

    // The state cookie still rides the refusal-free path, since the whole
    // point is that the success branch keeps working behind a proxy.
    expect(res.cookies.get(NATIVE_HANDOFF_STATE_COOKIE)?.value).toBeTruthy();
  });

  it("rate-limited → scheme error, no state cookie, no DB write", async () => {
    vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
      allowed: false,
      ip: "1.2.3.4",
    } as never);
    const res = await GET(req());
    expect(res.headers.get("location")).toBe(
      "healthlog://login-callback?error=rate_limited",
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
