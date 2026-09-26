import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Local lab OCR runs tesseract's WebAssembly engine in a same-origin worker
 * served from `/tesseract/`. Compiling WebAssembly needs `'wasm-unsafe-eval'`
 * in `script-src`, and a worker takes its CSP from its own script's response.
 * The grant is scoped the way the AI-host and Withings carve-outs are: the
 * worker files and the two pages that start OCR, and nothing else.
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

function scriptSrc(pathname: string): string {
  const res = proxy(
    new NextRequest(`http://localhost${pathname}`, {
      headers: { cookie: "healthlog_session=sess-1" },
    }),
  );
  const csp = res.headers.get("content-security-policy") ?? "";
  return csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
}

describe("'wasm-unsafe-eval' for local OCR", () => {
  it.each([
    "/tesseract/worker.min.js",
    "/tesseract/tesseract-core-simd-lstm.wasm.js",
    "/labs",
    "/documents",
  ])("is granted on %s", (path) => {
    expect(scriptSrc(path)).toContain("'wasm-unsafe-eval'");
  });

  it.each([
    "/dashboard",
    "/",
    "/labs/some-biomarker",
    "/settings/labs",
    "/settings/ai",
    "/api/labs/ocr/commit",
    "/tesseractish",
  ])("is not granted on %s", (path) => {
    const src = scriptSrc(path);
    expect(src).toContain("script-src");
    expect(src).not.toContain("wasm-unsafe-eval");
  });

  it("never widens script-src to plain eval", () => {
    expect(scriptSrc("/tesseract/worker.min.js")).not.toContain(
      "'unsafe-eval'",
    );
  });
});
