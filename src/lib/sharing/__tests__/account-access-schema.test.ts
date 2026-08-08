import { describe, expect, it } from "vitest";

import { parseAccountAccess } from "../account-access-schema";

const sharedEntry = {
  accountId: "record-a",
  username: "record-a",
  displayName: "Record A",
  fullName: "Test Full Name",
  access: "read",
  level: "read",
  recordKind: "shared",
  sections: ["labs"],
  canWrite: false,
};

function accessBlock(overrides: Record<string, unknown> = {}) {
  return {
    accounts: [sharedEntry],
    active: sharedEntry,
    recordKind: "shared",
    canSwitch: true,
    ...overrides,
  };
}

describe("parseAccountAccess", () => {
  it("preserves canonical shared payloads, including an empty scope", () => {
    const scoped = parseAccountAccess(accessBlock());
    const empty = parseAccountAccess(
      accessBlock({
        accounts: [{ ...sharedEntry, sections: [] }],
        active: { ...sharedEntry, sections: [] },
      }),
    );

    expect(scoped?.active?.sections).toEqual(["labs"]);
    expect(empty?.active?.sections).toEqual([]);
  });

  it("preserves the canonical manage compatibility fields", () => {
    const manager = {
      ...sharedEntry,
      access: "write",
      level: "manage",
      sections: null,
      canWrite: true,
    };

    const parsed = parseAccountAccess(
      accessBlock({ accounts: [manager], active: manager }),
    );

    expect(parsed?.active).toMatchObject({
      level: "manage",
      access: "write",
      sections: null,
      canWrite: true,
    });
  });

  it.each([
    [
      "legacy access and resolved level",
      { access: "write", level: "write", canWrite: true },
      {},
    ],
    ["record kind", { recordKind: "managed" }, { recordKind: "managed" }],
    ["scope", { sections: ["measurements"] }, {}],
    [
      "resolved write capability",
      { access: "write", level: "write", canWrite: true },
      {},
    ],
    ["username", { username: "different-record" }, {}],
    ["display name", { displayName: "Different record" }, {}],
    // v1.37.2 — the owner's full name is part of the entry now, so the two
    // published views of the active record must agree on it like every other
    // field. A parity matcher blind to it would let the banner and the
    // switcher name the same owner differently.
    ["full name", { fullName: "Different name" }, {}],
  ])(
    "fails closed when active disagrees with its canonical entry on %s",
    (_field, activeOverrides, blockOverrides) => {
      const active = { ...sharedEntry, ...activeOverrides };
      const block = accessBlock({ active, ...blockOverrides });

      expect(parseAccountAccess(block)).toBeNull();
    },
  );

  it.each([
    ["unknown level", { level: "owner" }],
    ["unknown record kind", { recordKind: "other" }],
    ["unknown section", { sections: ["other"] }],
    ["duplicated section", { sections: ["labs", "labs"] }],
    ["non-array section", { sections: "labs" }],
    ["read marked writable", { canWrite: true }],
    ["write marked read-only", { access: "write", level: "write" }],
    [
      "scoped manage",
      { access: "write", level: "manage", sections: ["labs"], canWrite: true },
    ],
    [
      "manage with read legacy field",
      { access: "read", level: "manage", sections: null, canWrite: true },
    ],
  ])("fails closed for %s entries", (_name, entryOverrides) => {
    const entry = { ...sharedEntry, ...entryOverrides };

    expect(
      parseAccountAccess(accessBlock({ accounts: [entry], active: entry })),
    ).toBeNull();
  });

  it("fails closed for a stale active entry or a contradictory switch block", () => {
    expect(
      parseAccountAccess(
        accessBlock({ active: { ...sharedEntry, accountId: "stale-record" } }),
      ),
    ).toBeNull();
    expect(parseAccountAccess(accessBlock({ canSwitch: false }))).toBeNull();
    expect(
      parseAccountAccess({
        accounts: [],
        active: null,
        recordKind: "self",
        canSwitch: true,
      }),
    ).toBeNull();
  });
});
