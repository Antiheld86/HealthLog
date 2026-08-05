/**
 * The second E2E server: the app as self-hosters actually run it.
 *
 * `playwright.config.ts` starts the main server with
 * `DASHBOARD_SSR_PREFETCH=false`, because the dashboard specs mock `/api/*`
 * through `page.route` and a route mock only sees CLIENT fetches — an
 * SSR-embedded snapshot would bypass every fixture. That trade is sound for
 * those specs and wrong for the product: the flag ships ON, so the whole suite
 * was proving a configuration nobody runs.
 *
 * This module names the second server so the config and the one spec that
 * uses it cannot drift on a port number. With `E2E_SKIP_WEB_SERVER=1` neither
 * server is started for you and both have to be running — the same contract
 * that already applies to the main one.
 */
export const SSR_PREFETCH_PORT = 3100;

export const SSR_PREFETCH_BASE_URL =
  process.env.E2E_SSR_PREFETCH_BASE_URL ??
  `http://localhost:${SSR_PREFETCH_PORT}`;
