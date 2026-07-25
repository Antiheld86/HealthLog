import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Operator-shared central Codex (ChatGPT subscription) — two mocked flows:
 *
 *   A. The per-user opt-in switch on /settings/ai, shown only when the operator
 *      has connected the shared account (`centralCodexAvailable: true`). Toggle
 *      on → honesty confirm → PATCH /api/auth/me/use-central-codex.
 *   B. The admin connect surface on /admin/coach: device-code panel →
 *      connected state, driven by the three admin endpoints.
 *
 * The real OAuth handshake bounces through chatgpt.com, which CI never hits;
 * every relevant endpoint is mocked so the assertions focus on the UI state.
 */
test.describe("central codex opt-in switch (mocked)", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("switch shows when available and writes the opt-in on confirm", async ({
    page,
  }) => {
    let useCentralCodex = false;

    await page.route("**/api/insights/settings", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            codexStatus: "disconnected",
            codexConnectedAt: null,
            hasAdminKey: false,
            codexOauthConfigured: true,
            centralCodexAvailable: true,
            useCentralCodex,
            privacyMode: "aggregated",
            lastInsightAt: null,
          },
          error: null,
        }),
      }),
    );

    await page.route("**/api/user/ai-provider", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            provider: null,
            model: null,
            baseUrl: null,
            hasAnthropicKey: false,
            anthropicKeyPreview: null,
            hasLocalKey: false,
            hasOpenaiKey: false,
            openaiKeyPreview: null,
            responseTimeoutSeconds: null,
          },
          error: null,
        }),
      }),
    );

    await page.route("**/api/insights/provider-chain", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            activeProvider: "codex",
            cachedActiveProvider: null,
            configuredChain: [{ providerType: "codex", available: true }],
          },
          error: null,
        }),
      }),
    );

    await page.route("**/api/auth/me/documents-auto-ai-read", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { documentsAutoAiRead: false },
          error: null,
        }),
      }),
    );

    await page.route("**/api/consent/ai/web", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { ok: true }, error: null }),
      }),
    );

    // The opt-in write — flips the mocked state so a re-read reflects it.
    await page.route("**/api/auth/me/use-central-codex", (route) => {
      useCentralCodex = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { useCentralCodex: true },
          error: null,
        }),
      });
    });

    await page.goto("/settings/ai", { waitUntil: "domcontentloaded" });

    const toggle = page.getByTestId("use-central-codex-enable");
    await expect(toggle).toBeVisible({ timeout: 10_000 });

    // Off → on reveals the honesty confirm; the write only happens on confirm.
    await toggle.click();
    const confirm = page.locator('[data-slot="central-codex-confirm-cta"]');
    await expect(confirm).toBeVisible();

    const wrote = page.waitForRequest(
      (req) =>
        req.url().includes("/api/auth/me/use-central-codex") &&
        req.method() === "PATCH",
    );
    await confirm.click();
    await wrote;
  });
});

test.describe("admin central codex connect (mocked)", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("connect button → device panel → connected badge", async ({ page }) => {
    let connected = false;

    await page.route("**/api/admin/central-codex", (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            status: connected ? "connected" : "disconnected",
            connectedAt: connected ? new Date().toISOString() : null,
          },
          error: null,
        }),
      });
    });

    await page.route("**/api/admin/central-codex/device-start", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            userCode: "WXYZ-7890",
            verificationUrl: "https://chatgpt.com/codex/device",
            intervalSeconds: 1,
          },
          error: null,
        }),
      }),
    );

    let pollCount = 0;
    await page.route("**/api/admin/central-codex/device-poll", (route) => {
      pollCount += 1;
      if (pollCount >= 2) connected = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { status: pollCount >= 2 ? "connected" : "pending" },
          error: null,
        }),
      });
    });

    await page.goto("/admin/coach", { waitUntil: "domcontentloaded" });

    const connect = page.locator('[data-slot="admin-central-codex-connect"]');
    await expect(connect).toBeVisible({ timeout: 10_000 });
    await connect.click();

    // Device-code panel surfaces the user code.
    await expect(page.getByText("WXYZ-7890")).toBeVisible();

    // After the mocked poll flips to connected, the disconnect action shows.
    await expect(
      page.locator('[data-slot="admin-central-codex-disconnect"]'),
    ).toBeVisible({ timeout: 15_000 });
  });
});
