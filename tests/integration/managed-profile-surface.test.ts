/**
 * Every mutation and read the managed-profile surface can issue, through the
 * real routes and a real Postgres.
 *
 * The browser card is proved from a static render in
 * `src/components/settings/access/__tests__/managed-profile-affordances.test.tsx`,
 * which can say that a control exists and nothing about what happens when it is
 * pressed. This file is the other half: the same calls the card makes, against
 * the handlers themselves, including every refusal the card renders a sentence
 * for.
 *
 * The roster read is where most of the weight sits, because it is the one
 * capability this release adds to the server. Its field set is asserted with
 * `Object.keys` rather than by presence: an over-disclosing route passes every
 * "contains" assertion ever written about it, and the decision that the roster
 * publishes no e-mail address is a privacy decision rather than plumbing.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar, queuedSessionIds } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { createManagedProfile } from "@/lib/managed-profiles/create";
import { acceptGrant, inviteGrant } from "@/lib/sharing/grants";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-managed-profile-surface-32-bytes-min-1234509876";

const { hashToken } = await import("@/lib/auth/hmac");

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar, queuedSessionIds } =
    await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => {
      const snapshot = new Map(cookieJar);
      const queuedSessionId = queuedSessionIds.shift();
      if (queuedSessionId) {
        snapshot.set("healthlog_session", queuedSessionId);
      }
      return {
        get: (name: string) => {
          const value = snapshot.get(name);
          return value ? { name, value } : undefined;
        },
        set: (name: string, value: string) => {
          cookieJar.set(name, value);
        },
        delete: (name: string) => {
          cookieJar.delete(name);
        },
      };
    }),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

let sequence = 0;

interface Person {
  id: string;
  username: string;
  sessionId: string;
}

/** An account with a second factor and a session that has just proved it. */
async function person(label: string): Promise<Person> {
  const suffix = sequence++;
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `${label}-${suffix}`,
      email: `${label}-${suffix}@example.test`,
      totpConfirmedAt: new Date(),
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      mfaVerifiedAt: new Date(),
    },
  });
  return { id: user.id, username: user.username, sessionId: session.id };
}

function signIn(who: Person): void {
  headerJar.delete("authorization");
  cookieJar.set("healthlog_session", who.sessionId);
}

/** A wildcard Bearer token for `who`, with no cookie session armed. */
async function signInWithBearer(who: Person): Promise<void> {
  const raw = `hlk_surface_${"0".repeat(48)}`;
  await getPrismaClient().apiToken.create({
    data: {
      userId: who.id,
      name: "surface",
      tokenHash: hashToken(raw),
      permissions: ["*"],
    },
  });
  cookieJar.clear();
  headerJar.set("authorization", `Bearer ${raw}`);
}

async function listGuardians(profileId: string) {
  const { GET } =
    await import("@/app/api/managed-profiles/[id]/guardians/route");
  return GET(
    new NextRequest(
      `http://localhost/api/managed-profiles/${profileId}/guardians`,
      { method: "GET" },
    ),
    { params: Promise.resolve({ id: profileId }) },
  );
}

/** A profile with its creator as sole Guardian, plus a pending second one. */
async function profileWithPendingSecondGuardian() {
  const creator = await person("creator");
  const invitee = await person("invitee");
  const { profile } = await createManagedProfile({
    creatorId: creator.id,
    displayName: "Managed record",
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  const invitation = await inviteGrant({
    grantorId: profile.id,
    granteeId: invitee.id,
    access: "MANAGE",
    scope: null,
  });
  return { creator, invitee, profile, invitation };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  queuedSessionIds.length = 0;
});

describe("who looks after a managed profile (real Postgres)", () => {
  it("shows an active Guardian every live grant, pending and accepted", async () => {
    const { creator, invitee, profile } =
      await profileWithPendingSecondGuardian();
    signIn(creator);

    const response = await listGuardians(profile.id);
    expect(response.status).toBe(200);
    const roster = (await response.json()).data as Array<
      Record<string, unknown>
    >;

    expect(roster).toHaveLength(2);
    const byName = new Map(
      roster.map((row) => [
        (row.account as { username: string }).username,
        row,
      ]),
    );
    expect(byName.get(creator.username)?.state).toBe("ACTIVE");
    expect(byName.get(creator.username)?.acceptedAt).toEqual(
      expect.any(String),
    );
    expect(byName.get(invitee.username)?.state).toBe("PENDING");
    expect(byName.get(invitee.username)?.acceptedAt).toBeNull();
  });

  it("discloses exactly five fields, and the party block carries no e-mail", async () => {
    // `Object.keys`, not `toContain`. A route that also published the
    // invitee's e-mail address, their notification channels or their last
    // access would satisfy every presence assertion in this file.
    const { profile, creator } = await profileWithPendingSecondGuardian();
    signIn(creator);

    const roster = (await (await listGuardians(profile.id)).json())
      .data as Array<Record<string, unknown>>;
    expect(roster.length).toBeGreaterThan(0);
    for (const row of roster) {
      expect(Object.keys(row).sort()).toEqual([
        "acceptedAt",
        "account",
        "grantId",
        "invitedAt",
        "state",
      ]);
      expect(Object.keys(row.account as object).sort()).toEqual([
        "displayName",
        "id",
        "username",
      ]);
    }
  });

  it("answers a second Guardian with the same roster", async () => {
    const { creator, invitee, profile, invitation } =
      await profileWithPendingSecondGuardian();
    await acceptGrant({ grantId: invitation.id, granteeId: invitee.id });

    signIn(creator);
    const first = (await (await listGuardians(profile.id)).json()).data;
    signIn(invitee);
    const second = (await (await listGuardians(profile.id)).json()).data;

    expect(second).toEqual(first);
    expect(
      (second as Array<{ state: string }>).every((r) => r.state === "ACTIVE"),
    ).toBe(true);
  });

  it("refuses somebody who is not a Guardian of that profile", async () => {
    const { profile } = await profileWithPendingSecondGuardian();
    const stranger = await person("stranger");
    signIn(stranger);

    const response = await listGuardians(profile.id);
    expect(response.status).toBe(404);
    expect((await response.json()).meta?.errorCode).toBe(
      "managed_profile.not_found",
    );
  });

  it("answers an unknown id with the same bytes as a refused one", async () => {
    // The refusal must not be an enumeration oracle: "no such profile" and
    // "not yours" have to be indistinguishable from the outside.
    const { profile } = await profileWithPendingSecondGuardian();
    const stranger = await person("stranger");
    signIn(stranger);

    const refused = await (await listGuardians(profile.id)).json();
    const unknown = await (await listGuardians("does-not-exist")).json();
    expect(unknown).toEqual(refused);
  });

  it.each(["READ", "WRITE", "MANAGE"] as const)(
    "refuses a %s delegate of an ordinary record against that record",
    async (access) => {
      // Holding a grant is not holding this read. An adult record whose owner
      // granted MANAGE is not a managed profile, and must 404 exactly as an
      // unknown id does.
      const owner = await person("owner");
      const delegate = await person("delegate");
      const invitation = await inviteGrant({
        grantorId: owner.id,
        granteeId: delegate.id,
        access,
        scope: null,
      });
      await acceptGrant({ grantId: invitation.id, granteeId: delegate.id });
      signIn(delegate);

      const response = await listGuardians(owner.id);
      expect(response.status).toBe(404);
      expect((await response.json()).meta?.errorCode).toBe(
        "managed_profile.not_found",
      );
    },
  );

  it("drops a revoked Guardian from the roster and refuses them the read", async () => {
    const { creator, invitee, profile, invitation } =
      await profileWithPendingSecondGuardian();
    await acceptGrant({ grantId: invitation.id, granteeId: invitee.id });
    await getPrismaClient().accountGrant.update({
      where: { id: invitation.id },
      data: { revokedAt: new Date(), revokedBy: "GRANTOR" },
    });

    signIn(invitee);
    expect((await listGuardians(profile.id)).status).toBe(404);

    signIn(creator);
    const roster = (await (await listGuardians(profile.id)).json())
      .data as Array<{ account: { username: string } }>;
    expect(roster).toHaveLength(1);
    expect(roster[0].account.username).toBe(creator.username);
  });

  it("drops an expired Guardian grant from the roster", async () => {
    const { creator, profile, invitation } =
      await profileWithPendingSecondGuardian();
    await getPrismaClient().accountGrant.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    signIn(creator);
    const roster = (await (await listGuardians(profile.id)).json())
      .data as Array<{ account: { username: string } }>;
    expect(roster).toHaveLength(1);
    expect(roster[0].account.username).toBe(creator.username);
  });

  it("refuses a Bearer caller, because the family is cookie-only", async () => {
    const { creator, profile } = await profileWithPendingSecondGuardian();
    await signInWithBearer(creator);

    // The same account, the same wildcard reach it has everywhere else, and
    // still no answer here: `requireCookieAuth` never falls through to the
    // Bearer branch.
    expect((await listGuardians(profile.id)).status).toBe(401);
  });
});
