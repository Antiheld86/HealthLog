/**
 * The large-upload routes are left out of the proxy matcher, so `apiHandler`
 * performs the proxy's duties for them: the worker-only and demo-mode
 * refusals, the transport security headers and a CSP. Every other route still
 * gets those from the proxy and is left untouched here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const runWeb = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => runWeb.value,
  shouldRunWorker: () => true,
  getProcessType: () => "all",
}));

import { apiHandler } from "@/lib/api-handler";

afterEach(() => {
  vi.unstubAllEnvs();
  runWeb.value = true;
});

function call(path: string, method = "POST") {
  const handler = vi.fn(async (_req: NextRequest) =>
    NextResponse.json({ data: "ok" }),
  );
  const wrapped = apiHandler(handler);
  return {
    handler,
    res: wrapped(new NextRequest(`http://localhost${path}`, { method })),
  };
}

describe("apiHandler on a route the proxy does not see", () => {
  it("adds the proxy's security headers and a CSP", async () => {
    const { res } = call("/api/measurements/batch");
    const r = await res;
    expect(r.status).toBe(200);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(r.headers.get("x-request-id")).toBeTruthy();
  });

  it("refuses a mutation on a demo instance before the handler runs", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const { res, handler } = call("/api/import/csv");
    const r = await res;
    expect(r.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(r.headers.get("x-frame-options")).toBe("DENY");
  });

  it("refuses in a worker-only container", async () => {
    runWeb.value = false;
    const { res, handler } = call("/api/admin/backups/upload");
    expect((await res).status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves a proxied route to the proxy", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const { res, handler } = call("/api/auth/me/timezone", "PUT");
    const r = await res;
    expect(handler).toHaveBeenCalled();
    expect(r.headers.get("content-security-policy")).toBeNull();
  });
});
