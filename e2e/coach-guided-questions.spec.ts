import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Guided clarifying-questions flow on the full-page Coach route
 * (v1.16.5 — V2 of the v1.16.0 composer chips).
 *
 * Contracts under test:
 *
 *   1. With pending self-context questions, the entry card
 *      (`data-slot="coach-guided-offer"`) renders above the composer
 *      and offers start / later / don't-ask-again.
 *   2. Starting the flow mounts the first deterministic question
 *      bubble in the thread (`data-slot="coach-guided-question"`,
 *      `data-state="current"`) with the progress line and the
 *      skip / later / dismiss actions.
 *   3. Skip advances to the next question without any server write.
 *   4. "Later" mid-sequence ends the flow without a summary when
 *      nothing was answered; the entry card stays hidden for the
 *      session.
 *   5. The entry-card "later" hides the offer without touching the
 *      thread.
 *
 *   6. v1.16.6 — answering a question streams a contextual Coach
 *      reaction (mocked SSE) BEFORE the next question appears; the
 *      sequence advances only once the adopt offer settles.
 *
 * The questions API is mocked; the answer test also mocks the chat SSE
 * POST (the reaction content itself is the model's business, only the
 * ordering contract is pinned here).
 */
test.describe("Coach guided clarifying questions", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  const QUESTIONS = [
    "Guided e2e question one?",
    "Guided e2e question two?",
    "Guided e2e question three?",
  ];
  const REACTION = "Thanks for sharing — that helps me read your numbers.";

  test.beforeEach(async ({ page }) => {
    // Empty conversation list so the page surface paints the empty
    // thread + history rail without hitting the database.
    // Wide pattern on purpose: the list GET may fire with or without a
    // cursor query. Neither the detail GET nor the SSE POST fires in
    // this spec (no conversation is opened, no message is sent).
    await page.route("**/api/insights/chat*", (route) => {
      // v1.16.6 — the answer test POSTs the guided answer through the
      // normal chat pipeline; serve a minimal SSE reaction. GETs keep
      // the empty conversation list.
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body:
            `data: ${JSON.stringify({ type: "token", token: REACTION })}\n\n` +
            `data: ${JSON.stringify({
              type: "done",
              conversationId: "conv-guided-e2e",
              messageId: "msg-guided-e2e",
            })}\n\n`,
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { conversations: [], nextCursor: null },
          error: null,
        }),
      });
    });
    // Detail refetch after the SSE `done` frame.
    await page.route("**/api/insights/chat/conv-guided-e2e", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "conv-guided-e2e",
            title: "Guided e2e",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageCount: 2,
            summary: null,
            messages: [
              {
                id: "msg-user-e2e",
                role: "user",
                content: "Yes, hypertension since 2019.",
                createdAt: new Date().toISOString(),
                metricSource: null,
                providerType: null,
                promptVersion: null,
              },
              {
                id: "msg-guided-e2e",
                role: "assistant",
                content: REACTION,
                createdAt: new Date().toISOString(),
                metricSource: null,
                providerType: "mock",
                promptVersion: null,
              },
            ],
          },
          error: null,
        }),
      }),
    );
    await page.route("**/api/insights/coach/nudge-status*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { nudgedAt: null, unread: false },
          error: null,
        }),
      }),
    );
    // Pending questions: GET serves the snapshot, DELETE (dismiss one
    // or all) empties it.
    await page.route("**/api/coach/about-me/questions*", (route) => {
      const isDelete = route.request().method() === "DELETE";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { questions: isDelete ? [] : QUESTIONS },
          error: null,
        }),
      });
    });
  });

  test("offer card starts the guided sequence; skip and later walk it", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "flow logic is viewport-independent; desktop run suffices",
    );

    await page.goto("/coach", { waitUntil: "domcontentloaded" });

    // 1. Entry card with the three choices.
    const offer = page.locator('[data-slot="coach-guided-offer"]');
    await expect(offer).toBeVisible({ timeout: 10_000 });
    await expect(
      offer.locator('[data-slot="coach-guided-offer-start"]'),
    ).toBeVisible();
    await expect(
      offer.locator('[data-slot="coach-guided-offer-later"]'),
    ).toBeVisible();
    await expect(
      offer.locator('[data-slot="coach-guided-offer-dismiss"]'),
    ).toBeVisible();

    // 2. Start → first question bubble (typing reveal lasts <1s).
    await offer.locator('[data-slot="coach-guided-offer-start"]').click();
    await expect(offer).toHaveCount(0);
    const question = page.locator(
      '[data-slot="coach-guided-question"][data-state="current"]',
    );
    await expect(question).toBeVisible({ timeout: 10_000 });
    await expect(question).toContainText(QUESTIONS[0], { timeout: 10_000 });
    await expect(
      question.locator('[data-slot="coach-guided-progress"]'),
    ).toContainText("1");

    // 3. Skip → second question, original numbering.
    await question.locator('[data-slot="coach-guided-skip"]').click();
    await expect(question).toContainText(QUESTIONS[1], { timeout: 10_000 });
    await expect(
      question.locator('[data-slot="coach-guided-progress"]'),
    ).toContainText("2");

    // 4. Later mid-sequence → flow ends, nothing answered → no summary,
    //    no question bubble, and the offer stays hidden for the session.
    await question.locator('[data-slot="coach-guided-later"]').click();
    await expect(
      page.locator('[data-slot="coach-guided-question"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-slot="coach-guided-summary"]'),
    ).toHaveCount(0);
    await expect(offer).toHaveCount(0);
  });

  test("entry-card later hides the offer without starting the flow", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "flow logic is viewport-independent; desktop run suffices",
    );

    await page.goto("/coach", { waitUntil: "domcontentloaded" });

    const offer = page.locator('[data-slot="coach-guided-offer"]');
    await expect(offer).toBeVisible({ timeout: 10_000 });
    await offer.locator('[data-slot="coach-guided-offer-later"]').click();
    await expect(offer).toHaveCount(0);
    await expect(
      page.locator('[data-slot="coach-guided-question"]'),
    ).toHaveCount(0);
  });

  test("an answer streams a Coach reaction before the next question", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "flow logic is viewport-independent; desktop run suffices",
    );

    await page.goto("/coach", { waitUntil: "domcontentloaded" });

    const offer = page.locator('[data-slot="coach-guided-offer"]');
    await expect(offer).toBeVisible({ timeout: 10_000 });
    await offer.locator('[data-slot="coach-guided-offer-start"]').click();

    const current = page.locator(
      '[data-slot="coach-guided-question"][data-state="current"]',
    );
    await expect(current).toContainText(QUESTIONS[0], { timeout: 10_000 });

    // Answer through the composer — the message rides the normal chat
    // pipeline (mocked SSE above).
    const textarea = page.locator('[data-slot="coach-input-textarea"]');
    await textarea.fill("Yes, hypertension since 2019.");
    await page.locator('[data-slot="coach-input-send"]').click();

    // Order contract: the streamed Coach reaction appears, the adopt
    // offer follows, and NO next question is current yet.
    await expect(page.getByText(REACTION).first()).toBeVisible({
      timeout: 10_000,
    });
    const adopt = page.locator('[data-slot="coach-self-context-adopt"]');
    await expect(adopt).toBeVisible({ timeout: 10_000 });
    await expect(current).toHaveCount(0);

    // Settling the offer (decline via ✕) releases the next question.
    await adopt
      .locator('[data-slot="coach-self-context-adopt-dismiss"]')
      .click();
    await expect(current).toContainText(QUESTIONS[1], { timeout: 10_000 });
    await expect(
      current.locator('[data-slot="coach-guided-progress"]'),
    ).toContainText("2");
  });
});
