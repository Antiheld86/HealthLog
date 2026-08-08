import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    accountGrant: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/db";
import { resolveAccountAccess } from "../account-access";
import { decodeLegacyWholeRecordAccess } from "../account-access-view";
import { LEGACY_ACCOUNT_PAYLOADS } from "../../../../tests/fixtures/v137/legacy-account-payloads";

function activeGrant({
  access,
  managedProfileAt = null,
}: {
  access: "READ" | "WRITE" | "MANAGE";
  managedProfileAt?: Date | null;
}) {
  return {
    id: `grant-${access.toLowerCase()}`,
    access,
    scopeJson: null,
    acceptedAt: new Date("2026-08-01T00:00:00.000Z"),
    revokedAt: null,
    expiresAt: null,
    grantor: {
      id: "record-owner",
      username: "record-owner",
      displayName: "Record owner",
      fullName: "Test Full Name",
      managedProfileAt,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveAccountAccess", () => {
  it("keeps MANAGE compatible with legacy access while publishing its canonical level", async () => {
    vi.mocked(prisma.accountGrant.findMany).mockResolvedValue([
      activeGrant({
        access: "MANAGE",
        managedProfileAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ] as never);

    const access = await resolveAccountAccess({
      user: { id: "delegate" },
      session: { actingAsUserId: "record-owner" },
    });

    expect(access.accounts).toEqual([
      expect.objectContaining({
        access: "write",
        level: "manage",
        sections: null,
        canWrite: true,
        recordKind: "managed",
      }),
    ]);
    expect(access.active).toEqual(
      expect.objectContaining({
        level: "manage",
        sections: null,
        recordKind: "managed",
      }),
    );
    expect(access.recordKind).toBe("managed");
  });

  it("resolves an ordinary shared record on the server", async () => {
    vi.mocked(prisma.accountGrant.findMany).mockResolvedValue([
      activeGrant({ access: "READ" }),
    ] as never);

    const access = await resolveAccountAccess({
      user: { id: "delegate" },
      session: {},
    });

    expect(access.accounts[0]).toEqual(
      expect.objectContaining({
        access: "read",
        level: "read",
        recordKind: "shared",
      }),
    );
    expect(access.recordKind).toBe("self");
  });

  it("carries the owner's full name to a read-only delegate", async () => {
    // v1.37.2 — the record owner's full name crosses to whoever they share
    // with, read-only included (maintainer decision 2026-08-08). It is the
    // resolver that lets it cross, so it is the resolver that proves it: a
    // READ grant, and the delegate's resolved entry still names the owner in
    // full. If a future change drops `fullName` from the grantor `select`,
    // this fails rather than silently reverting the disclosure to a nickname.
    vi.mocked(prisma.accountGrant.findMany).mockResolvedValue([
      activeGrant({ access: "READ" }),
    ] as never);

    const access = await resolveAccountAccess({
      user: { id: "delegate" },
      session: {},
    });

    expect(access.accounts[0]).toEqual(
      expect.objectContaining({
        access: "read",
        canWrite: false,
        fullName: "Test Full Name",
      }),
    );
  });

  it("keeps whole-record legacy payloads decodable and scoped payloads closed", () => {
    for (const fixture of LEGACY_ACCOUNT_PAYLOADS) {
      const decoded = decodeLegacyWholeRecordAccess(fixture);
      expect(decoded === null ? "deny" : "allow", fixture.name).toBe(
        fixture.legacyDecoder,
      );
      if (fixture.legacyDecoder === "allow") {
        expect(decoded).toBe(fixture.access);
      }
    }
  });
});
