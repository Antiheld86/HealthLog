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

/**
 * v1.37.0 — attach the record-session assertion the shipped browser client
 * attaches to every same-origin request.
 *
 * The record-session fence refuses a cookie request whose asserted context does
 * not match its session row, and it refuses a request that asserts nothing at
 * all once the session has been inside somebody's record. A test that moves
 * `acting_as_user_id` directly and then calls a route is therefore exercising
 * the fence's pre-fence-bundle arm, not whatever the test was written for — so
 * every such fixture calls this immediately after the switch.
 *
 * Truthful by construction: the values are read back off the row rather than
 * computed, so this can only ever say what the session actually holds. The
 * cases that want a STALE or ABSENT assertion set the headers themselves, and
 * they live in `tests/integration/record-session-fence*.test.ts`.
 *
 * Takes the epoch and scope rather than reading the database, so this module
 * keeps its single responsibility (shared mock state) and no test file has to
 * import a Prisma client it does not otherwise use.
 */
export function assertRecordContext(
  recordEpoch: number,
  actingAsUserId: string | null,
): void {
  headerJar.set("x-healthlog-record-epoch", String(recordEpoch));
  headerJar.set("x-healthlog-record-scope", actingAsUserId ?? "self");
}
