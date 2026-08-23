import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import {
  RETIRED_ROUTES,
  RETIRED_ROUTE_ERROR_CODE,
} from "@/lib/http/retired-routes";
import { apiError } from "@/lib/api-response";

/**
 * A retired path answers 410; nothing else changes.
 *
 * The failure this pins is not a crash — it is an answer that carries no
 * information. `/api/auth/me/research-mode` was removed on purpose and
 * answered a bare 404 for twelve days, which the native client read as a
 * transient fault and retried behind a button that could never succeed. 410 is
 * the status whose meaning is "this existed and is gone", so a client learns to
 * stop from the status line alone; the envelope carries the removing version
 * and the replacement for one that reads further.
 *
 * The three cases that matter are the three answers a path can get: retired,
 * live, and never-existed. The last one is the one a careless fix breaks —
 * turning every unknown path into a 410 would be worse than the 404 it
 * replaced, because it would assert history that never happened.
 *
 * Break-proofs, each run and confirmed red:
 *
 *   - Remove the retirement block from `src/proxy.ts` → five cases fail.
 *   - Answer 404 instead of 410 → three fail, including the anonymous one.
 *   - Turn the exact lookup into a `startsWith` → only the unknown-path case
 *     fails, which is the case that exists for exactly that mistake.
 *   - Drop `errorCode` from the envelope → the first case and the envelope
 *     equivalence both fail.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";

function request(pathname: string, method = "GET"): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, { method });
}

async function body(response: Response) {
  return (await response.json()) as {
    data: null;
    error: string;
    meta: {
      errorCode: string;
      removedIn: string;
      replacedBy: string | null;
    };
  };
}

describe("the proxy answers a retired path with 410", () => {
  it("answers 410 with the code, the removing version and the replacement", async () => {
    const response = proxy(request("/api/auth/me/research-mode"));

    expect(response.status).toBe(410);
    const payload = await body(response);
    expect(payload.data).toBeNull();
    expect(payload.meta.errorCode).toBe(RETIRED_ROUTE_ERROR_CODE);
    expect(payload.meta.removedIn).toBe("1.37.2");
    expect(payload.meta.replacedBy).toBeNull();
    expect(payload.error).toMatch(/removed in v1\.37\.2/);
  });

  it("carries the replacement path for a route that moved rather than went", async () => {
    const payload = await body(proxy(request("/api/fhir/$everything")));

    expect(payload.meta.replacedBy).toBe("/api/fhir/Patient/$everything");
  });

  it("answers every retired path, whatever the verb", async () => {
    // The path was retired, not a selection of methods on it. A client that
    // POSTed to `/api/bugreport` must not get a 404 for the verb it used while
    // a GET gets the tombstone.
    for (const route of RETIRED_ROUTES) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const response = proxy(request(route.path, method));
        expect(
          response.status,
          `${method} ${route.path} did not answer 410`,
        ).toBe(410);
      }
    }
  });

  it("needs no session and reads no credential", async () => {
    // The request below carries nothing: no session cookie, no Authorization
    // header. If the answer ever depended on one, a retired path would become
    // a way to tell an authenticated caller from an anonymous one.
    const anonymous = proxy(request("/api/auth/me/research-mode"));
    const withSession = new NextRequest(
      "http://localhost/api/auth/me/research-mode",
    );
    withSession.cookies.set("healthlog_session", "whatever");

    expect(anonymous.status).toBe(410);
    expect(proxy(withSession).status).toBe(410);
    expect(await body(anonymous)).toEqual(await body(proxy(withSession)));
  });

  it("carries the baseline security headers like every other early exit", () => {
    const response = proxy(request("/api/auth/me/research-mode"));

    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("leaves a live path alone", () => {
    // `/api/measurements` exists. The proxy must fall through to it, not decide
    // anything about it.
    expect(proxy(request("/api/measurements")).status).not.toBe(410);
    expect(proxy(request("/api/auth/me")).status).not.toBe(410);
    // The replacement for a moved route is a live path and must stay one.
    expect(proxy(request("/api/fhir/Patient/$everything")).status).not.toBe(
      410,
    );
  });

  it("leaves a genuinely unknown path to the ordinary 404", () => {
    // Nothing here claims this path ever existed, so the proxy must not answer
    // it at all — Next serves its own 404 downstream of the fall-through.
    for (const unknown of [
      "/api/auth/me/research-modes",
      "/api/auth/me/research-mode/extra",
      "/api/no-such-thing",
      "/api/bugreport-x",
    ]) {
      expect(proxy(request(unknown)).status, unknown).not.toBe(410);
    }
  });
});

describe("the 410 body is the standard error envelope", () => {
  it("is byte-identical to what apiError would have produced", async () => {
    // The proxy bundles separately from the route tree, so the envelope is
    // built as a plain object rather than by calling `apiError`. That is a
    // duplicated shape unless something holds the two together; this is that
    // something. A field added to the envelope builder and not to the
    // retirement answer fails here.
    const route = RETIRED_ROUTES[0];
    const fromProxy = await proxy(request(route.path)).json();
    const fromEnvelope = await apiError(
      `This endpoint was removed in v${route.removedIn} and is not coming back. Do not retry.`,
      410,
      {
        errorCode: RETIRED_ROUTE_ERROR_CODE,
        removedIn: route.removedIn,
        replacedBy: route.replacedBy,
      },
    ).json();

    expect(JSON.stringify(fromProxy)).toBe(JSON.stringify(fromEnvelope));
  });
});
