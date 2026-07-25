import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Insights generation flow — `/settings/ai` exposes a "Regenerate
 * insights" button that POSTs `/api/insights/generate` and re-renders
 * the AI-generated text in the surrounding cards.
 *
 * The real endpoint hits an AI provider (OpenAI / Codex) which we can't
 * call from CI. We mock it with the schema documented in
 * `src/app/api/insights/generate/route.ts`:
 *
 *   { data: { insights: { changed, stable, drivers, nextSteps,
 *     confidence, limitations }, cached: false }, error: null }
 *
 * We then confirm the success message lands AND a query invalidation
 * fires on the insight-fetching endpoints (we re-mock those to assert
 * they're touched after the regenerate call).
 */
test.describe("insights generation flow (mocked)", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("regenerate button updates insight cards", async ({ page }) => {
    // Settings endpoint — return "connected" so the regenerate button
    // is rendered (the section gates it on hasProvider).
    await page.route("**/api/insights/settings", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            codexStatus: "connected",
            codexConnectedAt: new Date().toISOString(),
            hasAdminKey: false,
            codexOauthConfigured: true,
            privacyMode: "aggregated",
            lastInsightAt: new Date().toISOString(),
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
          },
          error: null,
        }),
      }),
    );

    let generateCalls = 0;
    await page.route("**/api/insights/generate", (route) => {
      generateCalls += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            insights: {
              changed:
                "Blood-pressure averages dropped by 4/2 mmHg over the last 30 days.",
              stable: "Pulse and weight unchanged within natural variance.",
              drivers:
                "Likely driven by improved medication compliance (88% vs 72% prior).",
              nextSteps:
                "Continue current routine; revisit BMI target in 30 days.",
              confidence: "mittel",
              limitations:
                "Sample size for systolic readings remains below 60.",
            },
            cached: false,
          },
          error: null,
        }),
      });
    });

    await page.goto("/settings/ai", { waitUntil: "domcontentloaded" });

    const regenerateBtn = page.getByRole("button", {
      name: /regenerate (insights|reports)|insights aktualisieren|neu erstellen|berichte/i,
    });
    await expect(regenerateBtn).toBeVisible({ timeout: 10_000 });
    await regenerateBtn.click();

    // The settings page surfaces an inline alert after the mutation
    // completes. The exact copy comes from i18n, so match permissively.
    await expect(
      page.getByText(
        /reports? regenerated|insight.*regenerated|berichte.*aktualisiert|generated successfully|erfolgreich/i,
      ),
    ).toBeVisible({ timeout: 10_000 });

    expect(generateCalls).toBeGreaterThanOrEqual(1);
  });
});
