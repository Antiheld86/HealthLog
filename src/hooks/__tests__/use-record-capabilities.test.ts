/**
 * What a delegation lets somebody do, pinned as a table.
 *
 * The hook itself is one line over `useAuth`; the decision lives in
 * `resolveRecordCapabilities`, which is pure and has exactly three inputs a
 * session can be in. So the contract is enumerated here rather than inferred
 * from a rendered page — and every affordance in the sweep binds one of these
 * two booleans, which is what makes the sweep provable at all.
 *
 * Mutation checks, run:
 *   - return `canManage: true` for a WRITE record → "a delegate may not change
 *     what is already there" goes red.
 *   - return `canAdd: true` for a READ record → "a read-only delegate adds
 *     nothing" goes red.
 *   - make the `!active` branch return `canAdd: false` → "the caller's own
 *     record keeps everything" goes red.
 */
import { describe, expect, it } from "vitest";

import {
  recordContextIsUnproven,
  resolveRecordCapabilities,
} from "@/hooks/use-record-capabilities";
import type { AccountAccessEntry } from "@/lib/sharing/account-access-view";

const READ_ONLY: AccountAccessEntry = {
  accountId: "acct-owner",
  username: "owner",
  displayName: "Margarethe",
  access: "read",
  level: "read",
  sections: null,
  recordKind: "shared",
  canWrite: false,
};

const WRITABLE: AccountAccessEntry = {
  ...READ_ONLY,
  access: "write",
  level: "write",
  canWrite: true,
};

const MANAGING: AccountAccessEntry = {
  ...READ_ONLY,
  access: "write",
  level: "manage",
  canWrite: true,
};

const SCOPED: AccountAccessEntry = {
  ...READ_ONLY,
  sections: ["medications", "labs"],
};

describe("resolveRecordCapabilities", () => {
  it("the caller's own record keeps everything", () => {
    // `null` is not "no access", it is "this is mine". Both an unswitched
    // session and a payload from a server that has never heard of sharing
    // land here, which is why the absent case must be the permissive one.
    expect(resolveRecordCapabilities(null)).toEqual({
      inSharedRecord: false,
      canWrite: false,
      canAdd: true,
      canManage: true,
      // No grant, so no level and no narrowing — not a fabricated "manage"
      // over all eight sections, which a consumer would then have to tell
      // apart from a real one.
      level: null,
      sections: null,
      recordKind: "self",
    });
    expect(resolveRecordCapabilities(undefined)).toEqual(
      resolveRecordCapabilities(null),
    );
  });

  it("refuses a malformed published block instead of treating it as own record", () => {
    expect(resolveRecordCapabilities(null, true)).toEqual({
      inSharedRecord: true,
      canWrite: false,
      canAdd: false,
      canManage: false,
      level: null,
      sections: [],
      recordKind: "shared",
      accessRefused: true,
    });
  });

  it("a read-only delegate adds nothing", () => {
    expect(resolveRecordCapabilities(READ_ONLY)).toEqual({
      inSharedRecord: true,
      canWrite: false,
      canAdd: false,
      canManage: false,
      level: "read",
      sections: null,
      recordKind: "shared",
    });
  });

  it("a delegate may not change what is already there", () => {
    // The asymmetry the whole design rests on: a WRITE grant adds, and that
    // is all it does. Not even to an entry the delegate made a minute ago.
    expect(resolveRecordCapabilities(WRITABLE)).toEqual({
      inSharedRecord: true,
      canWrite: true,
      canAdd: true,
      canManage: false,
      level: "write",
      sections: null,
      recordKind: "shared",
    });
  });

  it("carries the level and the sections through untouched", () => {
    // The two facts v1.37.0 adds are bound, not interpreted. `sections` is
    // the server's list in the server's order; `level` is the server's word.
    // Nothing here filters, sorts or re-spells either, because the moment
    // this file starts deriving from them it becomes the second program
    // deciding what a delegation covers.
    expect(resolveRecordCapabilities(SCOPED).sections).toEqual([
      "medications",
      "labs",
    ]);
    expect(resolveRecordCapabilities(MANAGING).level).toBe("manage");
  });

  it("does not hand a manage grant the affordances its routes cannot answer yet", () => {
    // The deliberate gap, pinned so it cannot close by accident. MANAGE will
    // bring the edit and delete controls back, and it does so in the release
    // where the routes behind them answer — not in the one that merely
    // publishes the level. A `canManage: true` here today would paint
    // controls that 403, which is the exact failure these booleans exist to
    // prevent.
    expect(resolveRecordCapabilities(MANAGING)).toEqual({
      inSharedRecord: true,
      canWrite: true,
      canAdd: true,
      canManage: false,
      level: "manage",
      sections: null,
      recordKind: "shared",
    });
  });

  it("binds the server's boolean rather than the grant's label", () => {
    // `access` is descriptive; `canWrite` is the resolved decision. A row that
    // says "write" while the server resolved false (lapsed, revoked mid-flight,
    // a level this build does not honour) must read as read-only, because two
    // programs deciding one person's access is how they end up disagreeing.
    const disagreeing: AccountAccessEntry = {
      ...READ_ONLY,
      access: "write",
      canWrite: false,
    };
    expect(resolveRecordCapabilities(disagreeing).canAdd).toBe(false);
  });
});

/**
 * v1.37.0 — the record context has to be PROVABLE before the controls appear.
 *
 * `/api/auth/me` publishes the same question from two angles: `accountAccess.active`
 * is the re-decided answer (it survived a live-grant pass), and `recordSession.scope`
 * is the raw selector the fence compares a request's assertion against. When
 * they disagree the session is pointed at a record the grant no longer opens:
 * every delegable route will refuse, while `active` being null would otherwise
 * make this hook answer "your own record, all controls". That combination
 * paints an add button on a page whose every write is about to 403 — the exact
 * failure `canAdd` exists to end.
 */
describe("an unprovable record context withholds every control", () => {
  it("holds when the raw selector names a record the grant no longer opens", () => {
    expect(
      recordContextIsUnproven({ epoch: 3, scope: "acct-owner" }, null),
    ).toBe(true);
    const held = resolveRecordCapabilities(null, false, false, true);
    expect(held.canAdd).toBe(false);
    expect(held.canManage).toBe(false);
    expect(held.recordSessionPending).toBe(true);
  });

  it("holds when the resolved entry names a record the selector has left", () => {
    // The mirror image: the grant resolved, but the session is back on its own
    // record. Painting the owner's controls here would be the reverse mix-up.
    expect(recordContextIsUnproven({ epoch: 4, scope: null }, READ_ONLY)).toBe(
      true,
    );
  });

  it("agrees when both answers name the same record", () => {
    expect(
      recordContextIsUnproven(
        { epoch: 3, scope: READ_ONLY.accountId },
        READ_ONLY,
      ),
    ).toBe(false);
    expect(recordContextIsUnproven({ epoch: 0, scope: null }, null)).toBe(
      false,
    );
  });

  it("does not hold when there is no context to cross-check", () => {
    // Null is the Bearer transport (no session row, no switch state) and
    // undefined is a server image that predates the field. Neither is a
    // disagreement, and neither is a reason to blank the app for everybody.
    expect(recordContextIsUnproven(null, null)).toBe(false);
    expect(recordContextIsUnproven(undefined, READ_ONLY)).toBe(false);
    // The positive control for the two above: without it, a
    // `recordContextIsUnproven` that always returned false would pass them.
    expect(recordContextIsUnproven({ epoch: 1, scope: "someone" }, null)).toBe(
      true,
    );
  });

  it("leaves every existing arm untouched when the two agree", () => {
    // The fourth argument defaults to false, so every case above this block
    // means exactly what it meant before the fence existed.
    expect(resolveRecordCapabilities(READ_ONLY)).toEqual(
      resolveRecordCapabilities(READ_ONLY, false, false, false),
    );
  });
});
