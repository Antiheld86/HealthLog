import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { SSR_PREFETCH_BASE_URL } from "./setup/ssr-prefetch-server";

/**
 * The MCP consent screen hands the browser back to the connecting client.
 *
 * After "Allow", the consent form posts to its own origin and the server
 * answers with a redirect to the client's `redirect_uri`. Chromium applies the
 * consent page's CSP `form-action` to that redirect as well, so a page that
 * only allows `'self'` strands the user on the consent screen while the grant
 * has already been issued server-side. Only a real browser enforces CSP, which
 * is why this is an e2e journey and not a route test.
 *
 * It runs against the second server, the one started with `APP_URL`: the MCP
 * surface fails closed without a configured origin. The callback is a local
 * loopback listener, which is also what desktop MCP clients register.
 */
test.describe("MCP OAuth consent", () => {
  test.use({
    storageState: STORAGE_STATE_PATH,
    baseURL: SSR_PREFETCH_BASE_URL,
  });

  let callback: Server;
  let callbackUrl = "";
  const hits: URL[] = [];

  test.beforeAll(async () => {
    callback = createServer((req, res) => {
      hits.push(new URL(req.url ?? "/", callbackUrl));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Callback</title><p>Connected.</p>");
    });
    await new Promise<void>((resolve) =>
      callback.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = callback.address() as AddressInfo;
    callbackUrl = `http://127.0.0.1:${port}/callback`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => callback.close(() => resolve()));
  });

  test("Allow lands on the client's callback with a code", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "The redirect is enforced by the browser engine, not the layout; one Chromium run is the proof.",
    );

    // Register over the page's own connection rather than the shared API
    // request pool, which can hand out a socket the server already closed.
    await page.goto("/api/version");
    const registration = await page.evaluate(async (redirectUri) => {
      const res = await fetch("/api/mcp/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "E2E consent client",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
        }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }, callbackUrl);
    expect(registration.status, JSON.stringify(registration.body)).toBe(201);
    const clientId = (registration.body as { client_id: string }).client_id;

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(8).toString("hex");
    const origin = new URL(SSR_PREFETCH_BASE_URL).origin;
    const authorize = new URL("/api/mcp/oauth/authorize", origin);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callbackUrl,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "health:read",
      state,
      resource: `${origin}/mcp`,
    })) {
      authorize.searchParams.set(key, value);
    }

    await page.goto(authorize.toString());
    const allow = page.getByRole("button", { name: "Allow" });
    await expect(allow).toBeVisible();
    await allow.click();

    await page.waitForURL((url) => url.toString().startsWith(callbackUrl), {
      timeout: 15_000,
    });
    const hit = hits.at(-1);
    expect(hit, "the callback listener was never reached").toBeDefined();
    expect(hit!.searchParams.get("code")).toMatch(/^hlac_/);
    expect(hit!.searchParams.get("state")).toBe(state);
    expect(hit!.searchParams.get("iss")).toBe(origin);
  });
});
