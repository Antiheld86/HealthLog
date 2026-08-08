import { describe, expect, it } from "vitest";

import { accountLabel } from "../account-access-view";

/**
 * `accountLabel` is the one place the banner, the switcher and the sharing
 * panel resolve what to call a person, so the fallback order lives here and
 * is pinned here.
 *
 * v1.37.2 — the record owner's full name leads, ahead of the greeting name.
 * It is patient-identity data shown to everyone they share with, read-only
 * included (maintainer decision 2026-08-08); the switcher and the banner pass
 * the account-access entry that carries it, while the grant-view and actor
 * shapes that never had it omit the argument and keep the old behaviour.
 */
describe("accountLabel", () => {
  it("prefers the full name when it is set", () => {
    expect(
      accountLabel({
        fullName: "Test Full Name",
        displayName: "Testy",
        username: "test-user",
      }),
    ).toBe("Test Full Name");
  });

  it("falls back to the display name when there is no full name", () => {
    expect(
      accountLabel({
        fullName: null,
        displayName: "Testy",
        username: "test-user",
      }),
    ).toBe("Testy");
    // A blank full name is not a name — trimmed to empty, it falls through.
    expect(
      accountLabel({
        fullName: "   ",
        displayName: "Testy",
        username: "test-user",
      }),
    ).toBe("Testy");
  });

  it("falls back to the username when neither name is set", () => {
    expect(
      accountLabel({
        fullName: null,
        displayName: null,
        username: "test-user",
      }),
    ).toBe("test-user");
  });

  it("keeps the old two-field behaviour when no full name is passed", () => {
    // The grant-view and actor shapes never carried a full name; omitting the
    // argument must read exactly as it did before the field existed.
    expect(accountLabel({ displayName: "Testy", username: "test-user" })).toBe(
      "Testy",
    );
    expect(accountLabel({ displayName: null, username: "test-user" })).toBe(
      "test-user",
    );
  });
});
