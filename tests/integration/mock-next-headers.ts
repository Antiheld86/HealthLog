/**
 * Shared `next/headers` mock state for the integration suite.
 *
 * Background: vitest runs the integration suite with `isolate: false`
 * (one worker, one container). The factory passed to
 * `vi.mock("next/headers", ...)` is resolved ONCE per worker —
 * whichever test file loads first wins. If two files each declare a
 * top-level `const cookieJar = new Map()` and reference it from their
 * own `vi.mock("next/headers", ...)` factory, only the first file's
 * Map is ever read; the second file's writes silently disappear and
 * its tests flake based on import order.
 *
 * Fix: every integration file imports `cookieJar` + `headerJar` from
 * THIS module (a singleton) and clears them in `beforeEach`. The
 * `vi.mock` factory inside each test file resolves the Maps via
 * `await import()` so it sees the same Map instances regardless of
 * which file's mock factory ran first.
 */
export const cookieJar = new Map<string, string>();
export const headerJar = new Map<string, string>();

/**
 * Session snapshots for invoking concurrent route handlers as different users.
 * A request consumes one entry when its mocked cookie store is created.
 */
export const queuedSessionIds: string[] = [];
