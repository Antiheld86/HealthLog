/**
 * `getUnswitchedSession()` — the one gate every server-prefetching page sits
 * behind.
 *
 * The five pages that prefetch are otherwise unrelated to each other, so the
 * property they share has to live somewhere they all pass through, and this is
 * it. The four cases below are the whole state space of the cookie transport:
 * no session, a session in its own record, a session stamped onto somebody
 * else's, and a session carrying a selector header it has no business sending.
 *
 * Mutation checks, run:
 *   - return `session` unconditionally → "refuses while the session is
 *     stamped onto another record" goes red ("expected { user: … } to be
 *     null").
 *   - drop the `header` argument from the `decideActingCarrier` call → "refuses
 *     a session carrying a misplaced selector header" goes red the same way.
 *   - return `null` unconditionally → "hands back the session in the caller's
 *     own record" goes red, which is what stops the whole file from being
 *     satisfiable by a function that refuses everybody.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getSession = vi.fn();
const headerGet = vi.fn();

vi.mock("@/lib/auth/session", () => ({ getSession: () => getSession() }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => headerGet(name) }),
}));

import {
  ACCOUNT_SELECTOR_HEADER,
  getUnswitchedSession,
} from "../acting-carrier";

const OWN = {
  user: { id: "u-delegate" },
  session: { id: "s1", actingAsUserId: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  headerGet.mockReturnValue(null);
});

describe("getUnswitchedSession", () => {
  it("hands back the session in the caller's own record", async () => {
    getSession.mockResolvedValue(OWN);
    await expect(getUnswitchedSession()).resolves.toBe(OWN);
  });

  it("answers null when there is no session at all", async () => {
    getSession.mockResolvedValue(null);
    await expect(getUnswitchedSession()).resolves.toBeNull();
  });

  it("refuses while the session is stamped onto another record", async () => {
    // The stamp is what a switch IS on the cookie transport. A page that
    // prefetched through this would serialise `u-delegate`'s health record
    // into a document opened on `u-owner`'s.
    getSession.mockResolvedValue({
      ...OWN,
      session: { id: "s1", actingAsUserId: "u-owner" },
    });
    await expect(getUnswitchedSession()).resolves.toBeNull();
  });

  it("refuses a session carrying a misplaced selector header", async () => {
    // The header names no account on this transport, so it is not a switch and
    // the request would be served as the caller. It is still a client saying
    // it meant to be somewhere else, and a prefetch has nothing to gain by
    // guessing which of the two it meant.
    getSession.mockResolvedValue(OWN);
    headerGet.mockImplementation((name: string) =>
      name === ACCOUNT_SELECTOR_HEADER ? "u-owner" : null,
    );
    await expect(getUnswitchedSession()).resolves.toBeNull();
  });
});
