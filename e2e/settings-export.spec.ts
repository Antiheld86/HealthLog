import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Settings → Export & Import + Gesundheitsakte UI smoke.
 *
 * Validates that:
 *   1. The Export & Import surfaces (`/settings/export`) render with their
 *      stable testids: the four CSV/JSON tiles and the import cards.
 *   2. The import surfaces (v1.15.7, issue #281) render: the Apple Health
 *      and generic-JSON cards.
 *   3. The full health-record export panel lives on its own top-level
 *      `/settings/gesundheitsakte` section (v1.18.0 S5) — including the
 *      "included data" checklist, a disclosure collapsed by default that
 *      expands on demand.
 *   4. Clicking the Measurements CSV download button fires a real
 *      browser download — proving the `/api/export/measurements`
 *      endpoint is reachable from the browser end-to-end.
 *
 * The other CSV / JSON cards share the same code path; one happy-path
 * download is enough to lock in the wiring without doubling the e2e
 * runtime.
 */
test.describe("Settings → Export & Import", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("renders all export surfaces with stable testids", async ({ page }) => {
    await page.goto("/settings/export", { waitUntil: "domcontentloaded" });
    // v1.18.0 (S5) — the full health-record export moved to its own
    // `/settings/gesundheitsakte` section. The Export & Import page keeps
    // the four CSV/backup tiles with the `export-card-*` shape.
    for (const id of [
      "export-card-measurements-csv",
      "export-card-medications-csv",
      "export-card-mood-csv",
      "export-card-full-backup",
    ]) {
      await expect(page.getByTestId(id)).toBeVisible({ timeout: 10_000 });
    }
  });

  test("renders the health-record export panel on its own section", async ({
    page,
  }) => {
    // v1.18.0 (S5) — the health-record export is the hero of the
    // dedicated, module-gated Gesundheitsakte section.
    await page.goto("/settings/gesundheitsakte", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("health-record-export-panel")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("opens the scope picker expanded on a first run, fenced tier and all", async ({
    page,
  }) => {
    // The three panel states are the release's whole point, and the first one
    // is the only place a template is applied. It has to be VISIBLE — a
    // template behind a collapsed disclosure is opt-out wearing a hat — so the
    // picker, its twelve group rows and the fenced tier all render without a
    // click.
    await page.goto("/settings/gesundheitsakte", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("report-scope-picker")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("report-group-row-vitals")).toBeVisible();
    await expect(page.getByTestId("report-group-row-sensitive")).toHaveCount(0);
    await expect(page.getByTestId("report-sensitive-tier")).toBeVisible();
    // The fenced tier has no group control — there is no single click that
    // turns on more than one sensitive leaf.
    await expect(page.getByTestId("report-group-check-sensitive")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("report-scope-summary")).toBeVisible();
  });

  test("clears the tap floor on the group rows at 390 px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/gesundheitsakte", {
      waitUntil: "domcontentloaded",
    });
    const row = page.getByTestId("report-group-row-vitals");
    await expect(row).toBeVisible({ timeout: 10_000 });
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("opens a group's leaf grid from its chevron", async ({ page }) => {
    await page.goto("/settings/gesundheitsakte", {
      waitUntil: "domcontentloaded",
    });
    const row = page.getByTestId("report-group-row-vitals");
    await expect(row).toBeVisible({ timeout: 10_000 });
    // Collapsed: the leaves are behind the disclosure, which is what makes a
    // repeat run two interactions.
    await expect(page.getByTestId("report-leaf-PULSE")).toHaveCount(0);
    await row.getByRole("button", { expanded: false }).click();
    await expect(page.getByTestId("report-leaf-PULSE")).toBeVisible();
  });

  test("renders the import surfaces with stable testids", async ({ page }) => {
    await page.goto("/settings/export", { waitUntil: "domcontentloaded" });
    // v1.15.7 (issue #281) — the Apple Health and generic-JSON import
    // cards live in the same section, below the export options.
    for (const id of ["import-card-apple-health", "import-card-json"]) {
      await expect(page.getByTestId(id)).toBeVisible({ timeout: 10_000 });
    }
  });

  test("JSON import 'Download example' fires a real download", async ({
    page,
    isMobile,
  }) => {
    // Playwright's mobile emulation (Pixel 5 / isMobile) does not reliably
    // emit a `download` event for a Blob + anchor click — the click is treated
    // as a navigation, so `waitForEvent("download")` times out. The download
    // wiring is engine behaviour, not viewport-dependent, and is covered on the
    // chromium-desktop project; skip it on mobile rather than chase a flake.
    test.skip(isMobile, "downloads aren't observable under mobile emulation");
    await page.goto("/settings/export", { waitUntil: "domcontentloaded" });
    const exampleBtn = page.getByTestId("import-json-download-example");
    await expect(exampleBtn).toBeVisible({ timeout: 10_000 });

    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await exampleBtn.click();
    const download = await downloadPromise;

    const path = await download.path();
    expect(path).toBeTruthy();
    const fs = await import("node:fs/promises");
    const buf = await fs.readFile(path!);
    const parsed = JSON.parse(buf.toString("utf8"));
    expect(Array.isArray(parsed.measurements)).toBe(true);
    expect(Array.isArray(parsed.moodEntries)).toBe(true);
  });

  test("included-data checklist is collapsed by default and expands on demand", async ({
    page,
  }) => {
    // v1.18.0 (S5) — the panel (and its disclosure) live on the
    // dedicated Gesundheitsakte section now.
    await page.route("**/api/share-links", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [], error: null, meta: null }),
      });
    });
    const sharingDataReady = page.waitForResponse(
      (response) =>
        response.status() === 200 &&
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/share-links",
    );
    await page.goto("/settings/gesundheitsakte", {
      waitUntil: "domcontentloaded",
    });
    await sharingDataReady;
    const toggle = page.getByTestId("health-record-included-data-toggle");
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    // Collapsed on first render — the checklist panel is absent.
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByTestId("health-record-included-data-panel"),
    ).toHaveCount(0);
    // Expands on demand.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByTestId("health-record-included-data-panel"),
    ).toBeVisible();
  });

  test("Measurements CSV download fires a real download event", async ({
    page,
    isMobile,
  }) => {
    // See the JSON-download test above: mobile emulation does not emit a
    // `download` event for the anchor click. Covered on chromium-desktop.
    test.skip(isMobile, "downloads aren't observable under mobile emulation");
    // Stub the API so we don't need 90 days of seeded data — the
    // browser-side wiring is what we're validating, not the route's
    // DB query.
    await page.route("**/api/export/measurements*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/csv; charset=utf-8",
        headers: {
          "Content-Disposition":
            'attachment; filename="healthlog-measurements-test.csv"',
        },
        body: "type,value,unit,measuredAt,source,notes,glucoseContext\nWEIGHT,80,kg,2026-05-01T08:00:00.000Z,MANUAL,,\n",
      }),
    );

    await page.goto("/settings/export", { waitUntil: "domcontentloaded" });
    const downloadBtn = page.getByTestId("export-action-measurements-csv");
    await expect(downloadBtn).toBeVisible({ timeout: 10_000 });

    const downloadPromise = page.waitForEvent("download", {
      timeout: 30_000,
    });
    await downloadBtn.click();
    const download = await downloadPromise;

    const path = await download.path();
    expect(path).toBeTruthy();
    const fs = await import("node:fs/promises");
    const buf = await fs.readFile(path!);
    expect(buf.byteLength).toBeGreaterThan(0);
    expect(buf.toString("utf8")).toContain("WEIGHT,80,kg");
  });
});
