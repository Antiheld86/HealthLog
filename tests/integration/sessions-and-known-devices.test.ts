/**
 * Integration test — v1.23 active-session management + known-device ledger
 * against a real Postgres (migration 0203 applied by the container harness).
 *
 * Covers the DB-layer contracts the unit mocks can't pin:
 *   - destroyOtherSessions keeps the current session, deletes the rest, revokes
 *     native refresh tokens; with `reach: "sign-ins"` it leaves API tokens,
 *     connections and share links untouched, with `reach: "everything"` it
 *     ends them too (share links unless kept).
 *   - destroySessionById is scoped to the owning user (no cross-user delete)
 *     and takes the public handle, never the row id.
 *   - the (userId, deviceHash) unique index enforces the login-alert dedupe.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  destroyOtherSessions,
  destroySessionById,
  sessionHandle,
} from "@/lib/auth/session";
import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function makeUser(username: string) {
  return getPrismaClient().user.create({
    data: { username, email: `${username}@example.test` },
  });
}

describe("destroyOtherSessions", () => {
  it("sign-ins: keeps the current session, removes the others, revokes refresh tokens, keeps API tokens", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("sess-owner");

    const current = await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 1e6) },
    });
    await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 1e6) },
    });
    await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 1e6) },
    });
    const refresh = await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: "rt-hash-1",
        expiresAt: new Date(Date.now() + 1e6),
      },
    });
    const apiToken = await prisma.apiToken.create({
      data: {
        userId: user.id,
        name: "automation",
        tokenHash: "at-hash-1",
        permissions: ["*"],
      },
    });

    const result = await destroyOtherSessions(
      user.id,
      { kind: "session", sessionId: current.id },
      { reach: "sign-ins" },
    );
    expect(result.sessionsRevoked).toBe(2);

    const remaining = await prisma.session.findMany({
      where: { userId: user.id },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(current.id);

    const rt = await prisma.refreshToken.findUnique({
      where: { id: refresh.id },
    });
    expect(rt?.revokedAt).not.toBeNull();

    const at = await prisma.apiToken.findUnique({ where: { id: apiToken.id } });
    expect(at?.revoked).toBe(false);
  });
});

describe("destroySessionById", () => {
  it("revokes an owned session and refuses a cross-user id", async () => {
    const prisma = getPrismaClient();
    const owner = await makeUser("owner");
    const other = await makeUser("intruder");

    const ownerSession = await prisma.session.create({
      data: { userId: owner.id, expiresAt: new Date(Date.now() + 1e6) },
    });
    const otherSession = await prisma.session.create({
      data: { userId: other.id, expiresAt: new Date(Date.now() + 1e6) },
    });

    // Cross-user attempt: owner presents the intruder's handle.
    expect(
      await destroySessionById(owner.id, sessionHandle(otherSession.id)),
    ).toBe(false);
    expect(
      await prisma.session.findUnique({ where: { id: otherSession.id } }),
    ).not.toBeNull();

    // The row id is not an accepted key: a caller who somehow learned it
    // still cannot revoke with it, which is what keeps the id out of the
    // client's hands from being load-bearing in both directions.
    expect(await destroySessionById(owner.id, ownerSession.id)).toBe(false);
    expect(
      await prisma.session.findUnique({ where: { id: ownerSession.id } }),
    ).not.toBeNull();

    // Owned delete succeeds on the handle.
    expect(
      await destroySessionById(owner.id, sessionHandle(ownerSession.id)),
    ).toBe(true);
    expect(
      await prisma.session.findUnique({ where: { id: ownerSession.id } }),
    ).toBeNull();
  });
});

describe("UserKnownDevice unique index", () => {
  it("dedupes on (userId, deviceHash) — the same fingerprint cannot insert twice", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("device-owner");

    await prisma.userKnownDevice.create({
      data: {
        userId: user.id,
        deviceHash: "hash-abc",
        label: "Firefox on macOS",
      },
    });

    await expect(
      prisma.userKnownDevice.create({
        data: { userId: user.id, deviceHash: "hash-abc" },
      }),
    ).rejects.toThrow();

    // A different hash for the same user inserts fine.
    await prisma.userKnownDevice.create({
      data: { userId: user.id, deviceHash: "hash-def" },
    });

    const rows = await prisma.userKnownDevice.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(2);
  });
});

describe("destroyOtherSessions — native device logins", () => {
  it("revokes the access token paired with every other refresh token, and nothing else", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("sess-native-owner");
    const current = await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 1e6) },
    });
    // Two phones: each is a RefreshToken pointing at its login ApiToken.
    for (const n of ["a", "b"]) {
      await prisma.apiToken.create({
        data: {
          userId: user.id,
          name: `native-${n}`,
          tokenHash: `access-${n}`,
          permissions: ["*"],
        },
      });
      await prisma.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: `refresh-${n}`,
          accessTokenHash: `access-${n}`,
          expiresAt: new Date(Date.now() + 1e6),
        },
      });
    }
    // A programmatic token: no refresh row, managed under /settings/api-tokens.
    const automation = await prisma.apiToken.create({
      data: {
        userId: user.id,
        name: "automation",
        tokenHash: "hlk-automation",
        permissions: ["measurements:write"],
      },
    });
    // Another account's phone must be untouched.
    const other = await makeUser("sess-native-other");
    await prisma.apiToken.create({
      data: {
        userId: other.id,
        name: "native-other",
        tokenHash: "access-other",
        permissions: ["*"],
      },
    });
    await prisma.refreshToken.create({
      data: {
        userId: other.id,
        tokenHash: "refresh-other",
        accessTokenHash: "access-other",
        expiresAt: new Date(Date.now() + 1e6),
      },
    });

    const result = await destroyOtherSessions(
      user.id,
      { kind: "session", sessionId: current.id },
      { reach: "sign-ins" },
    );
    expect(result.accessTokensRevoked).toBe(2);

    const revoked = await prisma.apiToken.findMany({
      where: { tokenHash: { in: ["access-a", "access-b"] } },
      select: { revoked: true },
    });
    expect(revoked.map((t) => t.revoked)).toEqual([true, true]);
    const kept = await prisma.apiToken.findMany({
      where: { tokenHash: { in: [automation.tokenHash, "access-other"] } },
      select: { tokenHash: true, revoked: true },
    });
    expect(kept.every((t) => t.revoked === false)).toBe(true);
    const otherRefresh = await prisma.refreshToken.findUnique({
      where: { tokenHash: "refresh-other" },
    });
    expect(otherRefresh?.revokedAt).toBeNull();
  });

  it("spares the calling phone when the caller is a Bearer device login", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("sess-native-caller");
    for (const n of ["caller", "other"]) {
      await prisma.apiToken.create({
        data: {
          userId: user.id,
          name: `native-${n}`,
          tokenHash: `access-${n}`,
          permissions: ["*"],
        },
      });
      await prisma.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: `refresh-${n}`,
          accessTokenHash: `access-${n}`,
          expiresAt: new Date(Date.now() + 1e6),
        },
      });
    }
    await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 1e6) },
    });

    const result = await destroyOtherSessions(
      user.id,
      { kind: "accessToken", accessTokenHash: "access-caller" },
      { reach: "sign-ins" },
    );
    // A Bearer caller has no session row, so every browser session goes.
    expect(result.sessionsRevoked).toBe(1);
    expect(result.accessTokensRevoked).toBe(1);

    const caller = await prisma.refreshToken.findUnique({
      where: { tokenHash: "refresh-caller" },
    });
    expect(caller?.revokedAt).toBeNull();
    const callerAccess = await prisma.apiToken.findUnique({
      where: { tokenHash: "access-caller" },
    });
    expect(callerAccess?.revoked).toBe(false);
    const otherAccess = await prisma.apiToken.findUnique({
      where: { tokenHash: "access-other" },
    });
    expect(otherAccess?.revoked).toBe(true);
  });
});

describe("destroyOtherSessions — everything", () => {
  async function seedCredentials(userId: string) {
    const prisma = getPrismaClient();
    const token = await prisma.apiToken.create({
      data: {
        userId,
        name: "ingest",
        tokenHash: "narrow-hash",
        permissions: ["measurements:write"],
      },
    });
    const own = await prisma.apiToken.create({
      data: {
        userId,
        name: "caller",
        tokenHash: "access-caller",
        permissions: ["*"],
      },
    });
    const connection = await prisma.mcpOAuthConnection.create({
      data: {
        userId,
        clientId: "client",
        clientName: "Assistant",
        scope: "health:read",
        resource: "https://health.example/mcp",
        currentJti: "jti-1",
      },
    });
    const link = await prisma.clinicianShareLink.create({
      data: {
        userId,
        tokenHash: "share-hash",
        label: "Clinic",
        rangeStart: new Date("2026-01-01"),
        sectionsJson: { v: 2, leaves: [] },
        expiresAt: new Date(Date.now() + 1e9),
      },
    });
    return { token, own, connection, link };
  }

  it("revokes every token but the caller's, every connection and every share link", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("sess-everything");
    const seeded = await seedCredentials(user.id);

    const result = await destroyOtherSessions(
      user.id,
      { kind: "accessToken", accessTokenHash: "access-caller" },
      { reach: "everything" },
    );

    expect(result.connectorsRevoked).toBe(1);
    expect(result.shareLinksRevoked).toBe(1);
    expect(
      (
        await prisma.apiToken.findUniqueOrThrow({
          where: { id: seeded.token.id },
        })
      ).revoked,
    ).toBe(true);
    expect(
      (
        await prisma.apiToken.findUniqueOrThrow({
          where: { id: seeded.own.id },
        })
      ).revoked,
    ).toBe(false);
    expect(
      (
        await prisma.mcpOAuthConnection.findUniqueOrThrow({
          where: { id: seeded.connection.id },
        })
      ).revokedAt,
    ).not.toBeNull();
    expect(
      (
        await prisma.clinicianShareLink.findUniqueOrThrow({
          where: { id: seeded.link.id },
        })
      ).revokedAt,
    ).not.toBeNull();
  });

  it("keeps the share links when asked to, and still ends the rest", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("sess-keep-links");
    const seeded = await seedCredentials(user.id);

    const result = await destroyOtherSessions(
      user.id,
      { kind: "accessToken", accessTokenHash: "access-caller" },
      { reach: "everything", keepShareLinks: true },
    );

    expect(result.shareLinksRevoked).toBe(0);
    expect(result.connectorsRevoked).toBe(1);
    expect(
      (
        await prisma.clinicianShareLink.findUniqueOrThrow({
          where: { id: seeded.link.id },
        })
      ).revokedAt,
    ).toBeNull();
  });

  it("withdraws invitations nobody accepted and leaves accepted grants standing", async () => {
    const prisma = getPrismaClient();
    const owner = await makeUser("sess-invites-owner");
    const carer = await makeUser("sess-invites-carer");
    const stranger = await makeUser("sess-invites-stranger");
    const other = await makeUser("sess-invites-other");
    const accepted = await prisma.accountGrant.create({
      data: {
        grantorId: owner.id,
        granteeId: carer.id,
        access: "READ",
        acceptedAt: new Date(),
      },
    });
    const pending = await prisma.accountGrant.create({
      data: { grantorId: owner.id, granteeId: stranger.id, access: "WRITE" },
    });
    // Somebody else's invitation to the owner is not the owner's to withdraw.
    const received = await prisma.accountGrant.create({
      data: { grantorId: other.id, granteeId: owner.id, access: "READ" },
    });

    const result = await destroyOtherSessions(
      owner.id,
      { kind: "accessToken", accessTokenHash: "none" },
      { reach: "everything" },
    );

    expect(result.pendingInvitesRevoked).toBe(1);
    const after = async (id: string) =>
      prisma.accountGrant.findUniqueOrThrow({ where: { id } });
    expect((await after(pending.id)).revokedAt).not.toBeNull();
    expect((await after(pending.id)).revokedBy).toBe("GRANTOR");
    expect((await after(accepted.id)).revokedAt).toBeNull();
    expect((await after(received.id)).revokedAt).toBeNull();
  });

  it("sign-ins leaves pending invitations alone", async () => {
    const prisma = getPrismaClient();
    const owner = await makeUser("sess-invites-signins");
    const other = await makeUser("sess-invites-signins-2");
    const pending = await prisma.accountGrant.create({
      data: { grantorId: owner.id, granteeId: other.id, access: "READ" },
    });
    const result = await destroyOtherSessions(
      owner.id,
      { kind: "accessToken", accessTokenHash: "none" },
      { reach: "sign-ins" },
    );
    expect(result.pendingInvitesRevoked).toBe(0);
    expect(
      (
        await prisma.accountGrant.findUniqueOrThrow({
          where: { id: pending.id },
        })
      ).revokedAt,
    ).toBeNull();
  });

  it("sign-ins leaves connections, tokens and share links alone", async () => {
    const prisma = getPrismaClient();
    const user = await makeUser("sess-signins-only");
    const seeded = await seedCredentials(user.id);

    await destroyOtherSessions(
      user.id,
      { kind: "accessToken", accessTokenHash: "access-caller" },
      { reach: "sign-ins" },
    );

    expect(
      (
        await prisma.apiToken.findUniqueOrThrow({
          where: { id: seeded.token.id },
        })
      ).revoked,
    ).toBe(false);
    expect(
      (
        await prisma.mcpOAuthConnection.findUniqueOrThrow({
          where: { id: seeded.connection.id },
        })
      ).revokedAt,
    ).toBeNull();
  });
});

describe("destroyAllSessions", () => {
  it("also ends AI-assistant connections and share links", async () => {
    const prisma = getPrismaClient();
    const { destroyAllSessions } = await import("@/lib/auth/session");
    const user = await makeUser("sess-all");
    const connection = await prisma.mcpOAuthConnection.create({
      data: {
        userId: user.id,
        clientId: "client",
        clientName: "Assistant",
        scope: "health:read",
        resource: "https://health.example/mcp",
        currentJti: "jti-1",
      },
    });
    const link = await prisma.clinicianShareLink.create({
      data: {
        userId: user.id,
        tokenHash: "share-hash-all",
        label: "Clinic",
        rangeStart: new Date("2026-01-01"),
        sectionsJson: { v: 2, leaves: [] },
        expiresAt: new Date(Date.now() + 1e9),
      },
    });

    await destroyAllSessions(user.id);

    expect(
      (
        await prisma.mcpOAuthConnection.findUniqueOrThrow({
          where: { id: connection.id },
        })
      ).revokedAt,
    ).not.toBeNull();
    expect(
      (
        await prisma.clinicianShareLink.findUniqueOrThrow({
          where: { id: link.id },
        })
      ).revokedAt,
    ).not.toBeNull();
  });
});
