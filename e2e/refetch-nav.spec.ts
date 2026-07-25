import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * #316 follow-up — does the medications list refetch when you navigate
 * back to the page?
 *
 * Reporter: "TanStack Query is not fetching data on the medications page
 * or other areas when the data is stale, even when I navigate between
 * pages." In Next.js App Router a route-level page UNMOUNTS on navigation
 * away and remounts on return, so the query observer is recreated — but
 * the global `staleTime: 5min` makes `refetchOnMount: true` skip the
 * fetch while the cached data is still "fresh", so the page shows a
 * potentially stale list with no network round-trip.
 *
 * This spec counts `/api/medications` requests across a client-side
 * round-trip (medications → dashboard → medications). The DESIRED
 * (post-fix) behaviour is a fresh fetch on return; pre-fix the count
 * stays at 1, which is the reproduction.
 *
 * Desktop-only: the assertion is about query behaviour, and the sidebar
 * nav links it clicks live behind a drawer on the mobile project.
 */
test.use({ storageState: STORAGE_STATE_PATH });

test("medications list refetches on client-side navigation back to the page", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.includes("mobile"),
    "sidebar nav links are drawer-gated on mobile; query behaviour is project-independent",
  );
  let medsRequests = 0;
  page.on("request", (req) => {
    try {
      const u = new URL(req.url());
      if (u.pathname === "/api/medications") medsRequests += 1;
    } catch {
      /* non-URL request — ignore */
    }
  });

  // Initial load — the list query mounts and fetches once. Arm the waiter
  // BEFORE navigating: `goto` resolves on load, so a response that already
  // arrived would never be seen by a listener attached afterwards, and the
  // wait would time out on an event that had long since happened.
  const firstListFetch = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/medications",
  );
  await page.goto("/medications");
  await firstListFetch;
  expect(medsRequests).toBe(1);

  // Client-side nav AWAY (dashboard) then BACK — App Router unmounts and
  // remounts the medications page. A full page.goto() would reset the
  // client cache and always refetch, so we click the sidebar links.
  await page.locator('a[href="/"]').first().click();
  await page.waitForURL("**/");
  await page.locator('a[href="/medications"]').first().click();
  await page.waitForURL("**/medications");

  // Desired: the return mounts a fresh observer that refetches. Pre-fix
  // the 5-min staleTime masks it and this stays at 1 (the bug). Poll rather
  // than sleeping a fixed span: it returns the moment the refetch lands, and
  // it does not turn a slow CI machine into a false failure.
  await expect
    .poll(() => medsRequests, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(2);
});
