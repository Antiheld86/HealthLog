import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The MCP OAuth authorization endpoint owns its CSP: its consent form leads to
 * the connecting client's redirect URI, and Chromium applies `form-action` to
 * that redirect. Middleware headers override route headers, so the proxy must
 * not set a CSP on exactly that path, and must keep setting it everywhere else,
 * including the neighbouring OAuth endpoints.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`);
}

describe("proxy CSP on the MCP authorize endpoint", () => {
  it("leaves the CSP to the route on the authorize path", () => {
    const res = proxy(
      request("/api/mcp/oauth/authorize?client_id=x&redirect_uri=y"),
    );
    expect(res.headers.get("content-security-policy")).toBeNull();
    // Every other security header still applies there.
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps the app CSP on neighbouring and lookalike paths", () => {
    for (const path of [
      "/api/mcp/oauth/token",
      "/api/mcp/oauth/register",
      "/api/mcp/oauth/authorize/extra",
      "/api/mcp/oauth/authorizex",
      "/api/mcp/oauth",
    ]) {
      const csp = proxy(request(path)).headers.get("content-security-policy");
      expect(csp, path).toContain("form-action 'self';");
    }
  });
});
