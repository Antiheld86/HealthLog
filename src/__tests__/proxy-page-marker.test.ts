/**
 * The page marker `public/sw.js` uses to recognise that its origin still
 * serves HealthLog (#847). A successful navigation without it makes the
 * worker delete its caches and unregister, so the marker has to be on every
 * page the proxy lets through, signed in or not, and it must never carry a
 * version.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { HEALTHLOG_PAGE_MARKER_HEADER, proxy } from "../proxy";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(pathname: string, signedIn = true): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    headers: signedIn
      ? { cookie: "healthlog_session=sess-1", accept: "text/html" }
      : { accept: "text/html" },
  });
}

describe("proxy.ts page marker for the service worker", () => {
  it.each(["/", "/measurements", "/settings/profile", "/c/hls_abc123"])(
    "marks the signed-in page %s",
    (path) => {
      const res = proxy(request(path));
      expect(res.headers.get(HEALTHLOG_PAGE_MARKER_HEADER)).toBe("1");
    },
  );

  it.each(["/auth/login", "/privacy", "/onboarding"])(
    "marks the public page %s",
    (path) => {
      const res = proxy(request(path, false));
      expect(res.headers.get(HEALTHLOG_PAGE_MARKER_HEADER)).toBe("1");
    },
  );

  it.each(["/api/version", "/api/measurements", "/api/auth/me"])(
    "leaves the API response %s unmarked",
    (path) => {
      const res = proxy(request(path));
      expect(res.headers.has(HEALTHLOG_PAGE_MARKER_HEADER)).toBe(false);
    },
  );

  it("carries presence only, never a version or build id", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "9.9.9");
    const res = proxy(request("/"));
    expect(res.headers.get(HEALTHLOG_PAGE_MARKER_HEADER)).toBe("1");
  });

  it("uses the header name public/sw.js checks", () => {
    const sw = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
    expect(sw).toContain(
      `const HEALTHLOG_PAGE_MARKER_HEADER = "${HEALTHLOG_PAGE_MARKER_HEADER}";`,
    );
  });
});
