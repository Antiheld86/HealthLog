/**
 * The account-grant state machine, tested where it is pure.
 *
 * Everything that asserts what lands in the database lives in
 * `tests/integration/account-grant-lifecycle.test.ts` against real Postgres —
 * the partial unique index, the conditional-update claims and both cascade
 * directions are properties of the database, and a fake client that ignores
 * `where` would report all three as working.
 *
 * What is left here is the decision itself: given a row, what does it confer?
 * That question has no database in it, and it is the one the resolver asks on
 * every single request.
 */
import { describe, expect, it } from "vitest";

import {
  grantAllows,
  grantState,
  isGrantActive,
  type GrantLifecycle,
} from "@/lib/sharing/grants";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const EARLIER = new Date("2026-08-01T12:00:00.000Z");
const LATER = new Date("2026-08-03T12:00:00.000Z");

function grant(overrides: Partial<GrantLifecycle> = {}): GrantLifecycle {
  return {
    acceptedAt: EARLIER,
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe("grantState", () => {
  it("is ACTIVE once accepted, with no end date", () => {
    expect(grantState(grant(), NOW)).toBe("ACTIVE");
  });

  it("is PENDING until the delegate accepts", () => {
    expect(grantState(grant({ acceptedAt: null }), NOW)).toBe("PENDING");
  });

  it("is EXPIRED once the lapse instant has arrived", () => {
    // The named instant is the first instant the grant no longer holds, the
    // same boundary the Bearer-token expiry uses.
    expect(grantState(grant({ expiresAt: NOW }), NOW)).toBe("EXPIRED");
    expect(grantState(grant({ expiresAt: EARLIER }), NOW)).toBe("EXPIRED");
    expect(grantState(grant({ expiresAt: LATER }), NOW)).toBe("ACTIVE");
  });

  it("is EXPIRED rather than PENDING for an invitation that lapsed", () => {
    // The distinction is load-bearing: an invitation past its date can no
    // longer be accepted, and calling it PENDING would say the opposite.
    expect(
      grantState(grant({ acceptedAt: null, expiresAt: EARLIER }), NOW),
    ).toBe("EXPIRED");
  });

  it("is REVOKED even when it also sat past its expiry", () => {
    // Somebody ended it. The record says so, rather than attributing the end
    // to a calendar.
    expect(
      grantState(grant({ revokedAt: EARLIER, expiresAt: EARLIER }), NOW),
    ).toBe("REVOKED");
  });

  it("is REVOKED for a pending invitation the owner withdrew", () => {
    expect(
      grantState(grant({ acceptedAt: null, revokedAt: EARLIER }), NOW),
    ).toBe("REVOKED");
  });
});

describe("isGrantActive", () => {
  it("confers nothing while pending", () => {
    expect(isGrantActive(grant({ acceptedAt: null }), NOW)).toBe(false);
  });

  it("confers nothing once revoked", () => {
    expect(isGrantActive(grant({ revokedAt: EARLIER }), NOW)).toBe(false);
  });

  it("confers nothing once expired", () => {
    expect(isGrantActive(grant({ expiresAt: EARLIER }), NOW)).toBe(false);
  });

  it("stops conferring the moment the clock passes the expiry", () => {
    // Live, not swept: the same unchanged row answers differently as the
    // clock moves, with nothing having run in between.
    const lapsing = grant({ expiresAt: NOW });
    expect(isGrantActive(lapsing, EARLIER)).toBe(true);
    expect(isGrantActive(lapsing, NOW)).toBe(false);
  });

  it("confers access when accepted, live and unexpired", () => {
    expect(isGrantActive(grant({ expiresAt: LATER }), NOW)).toBe(true);
  });
});

describe("grantAllows", () => {
  it("lets a READ grant read and refuses it a write", () => {
    const read = { ...grant(), access: "READ" as const };
    expect(grantAllows(read, "read", NOW)).toBe(true);
    expect(grantAllows(read, "write", NOW)).toBe(false);
  });

  it("lets a WRITE grant do both", () => {
    const write = { ...grant(), access: "WRITE" as const };
    expect(grantAllows(write, "read", NOW)).toBe(true);
    expect(grantAllows(write, "write", NOW)).toBe(true);
  });

  it("refuses a WRITE grant that is not active", () => {
    // The level never outranks the state. A revoked WRITE grant is a revoked
    // grant.
    const revoked = {
      ...grant({ revokedAt: EARLIER }),
      access: "WRITE" as const,
    };
    expect(grantAllows(revoked, "read", NOW)).toBe(false);
    expect(grantAllows(revoked, "write", NOW)).toBe(false);
  });

  it("refuses a pending grant at every level", () => {
    for (const access of ["READ", "WRITE"] as const) {
      const pending = { ...grant({ acceptedAt: null }), access };
      expect(grantAllows(pending, "read", NOW)).toBe(false);
      expect(grantAllows(pending, "write", NOW)).toBe(false);
    }
  });
});
