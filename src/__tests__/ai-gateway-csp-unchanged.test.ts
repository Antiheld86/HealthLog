import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The OpenAI-compatible gateway provider (#470) needs no CSP change, and this
 * pins that.
 *
 * The reasoning is worth stating because the opposite conclusion is the
 * tempting one: the gateway's host is user-configured, so if the browser ever
 * had to reach it, `connect-src` would need a wildcard — which would undo the
 * surgical gating the AI settings surface has today. It does not: the
 * provider is resolved and called server-side (`/api/ai/test`,
 * `/api/insights/*`), so the browser only ever talks to this origin.
 *
 * If a future change makes the settings page call a gateway directly, this
 * test goes red, and that is the moment to have the argument.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";

function setNodeEnv(value: "development" | "production") {
  vi.stubEnv("NODE_ENV", value);
}

beforeEach(() => {
  setNodeEnv("production");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function connectSrcFor(pathname: string): string {
  const res = proxy(
    new NextRequest(`http://localhost${pathname}`, {
      headers: { cookie: "healthlog_session=sess-1" },
    }),
  );
  const csp = res.headers.get("content-security-policy") ?? "";
  const directive = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("connect-src"));
  return directive ?? "";
}

describe("AI settings connect-src is untouched by the gateway provider", () => {
  it("still allows exactly the two AI hosts it allowed before", () => {
    expect(connectSrcFor("/settings/ai")).toBe(
      "connect-src 'self' https://api.openai.com https://chatgpt.com",
    );
  });

  it("adds no AI host anywhere else", () => {
    expect(connectSrcFor("/dashboard")).toBe("connect-src 'self'");
  });
});
