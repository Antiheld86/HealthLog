/**
 * What the audit trail records for a delegated action, and for a self action.
 *
 * The whole feature rests on one reading: `actorUserId` NULL means the account
 * acted for itself. Every row written before the column existed means that,
 * and every row written after it will mostly mean it too — so a threading rule
 * that stamps an actor where none was acting does not add information, it
 * changes what several years of history says. That reading is what these tests
 * hold, against real rows.
 *
 * Round trips through the real routes, for the reason that cost this project a
 * release: a unit stub proves the code ran, not what landed. Here the question
 * is only ever "which row exists afterwards, and what is in its columns".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest, NextResponse } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables, switchSessionTo } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { auditLog, DELEGATED_ACCESS_ACTION } from "@/lib/auth/audit";
import { acceptGrant, inviteGrant } from "@/lib/sharing/grants";

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `audit-${suffix}`,
      email: `audit-${suffix}@example.test`,
      role: "USER",
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

/**
 * A delegable route that writes an audit row the way a migrated route does:
 * `userId` from the resolved data scope, and nothing about the actor, because
 * the actor is not the handler's business.
 */
const delegableAction: (request: NextRequest) => Promise<Response> = apiHandler(
  async () => {
    const { user } = await requireRecordAuth("read", "measurements");
    await auditLog("measurement.read", {
      userId: user.id,
      details: { via: "test" },
    });
    return NextResponse.json({ data: { ok: true }, error: null });
  },
);

/** The same handler's self-action case: no switch, same code path. */
function act(): Promise<Response> {
  return delegableAction(
    new NextRequest("http://localhost/api/test/delegable", { method: "GET" }),
  );
}

async function household() {
  const owner = await makeUser("owner");
  const delegate = await makeUser("delegate");
  const invited = await inviteGrant({
    grantorId: owner.id,
    granteeId: delegate.id,
    access: "READ",
    scope: null,
  });
  await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
  const session = await signIn(delegate.id);
  await switchSessionTo(session.id, owner.id);
  return { owner, delegate, session };
}

async function rowsFor(action: string) {
  return getPrismaClient().auditLog.findMany({
    where: { action },
    orderBy: { createdAt: "asc" },
  });
}

/** The resolver's access row is fire-and-forget; give it a tick to land. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("who the trail says did it", () => {
  it("files a delegated action under the owner, naming the delegate", async () => {
    const { owner, delegate } = await household();

    expect((await act()).status).toBe(200);

    const rows = await rowsFor("measurement.read");
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(owner.id);
    expect(rows[0].actorUserId).toBe(delegate.id);
  });

  it("leaves the actor NULL when somebody acts on their own record", async () => {
    // The load-bearing one. NULL is not "we did not know" — it is the
    // statement every historical row already makes, and the same handler,
    // unswitched, has to keep making it.
    const solo = await makeUser("solo");
    await signIn(solo.id);

    expect((await act()).status).toBe(200);

    const rows = await rowsFor("measurement.read");
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(solo.id);
    expect(rows[0].actorUserId).toBeNull();
  });

  it("leaves the actor NULL on a row a delegate writes about themselves", async () => {
    // A delegated request that files under the DELEGATE describes the
    // delegate's own act. Stamping the actor there would say "somebody else
    // did this to you" about a person acting on themselves.
    const { delegate } = await household();

    const handler: (request: NextRequest) => Promise<Response> = apiHandler(
      async () => {
        const { actor } = await requireRecordAuth("read", "measurements");
        await auditLog("delegate.own.act", { userId: actor.id });
        return NextResponse.json({ data: { ok: true }, error: null });
      },
    );
    await handler(
      new NextRequest("http://localhost/api/test/delegable", { method: "GET" }),
    );

    const rows = await rowsFor("delegate.own.act");
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(delegate.id);
    expect(rows[0].actorUserId).toBeNull();
  });

  it("leaves the actor NULL on a refused delegation", async () => {
    // The refusal row already exists (the resolver writes it). It is the
    // caller's own act — an attempt they made as themselves — and it must not
    // acquire an actor just because the request mentioned another account.
    const delegate = await makeUser("delegate");
    const stranger = await makeUser("stranger");
    const session = await signIn(delegate.id);
    await switchSessionTo(session.id, stranger.id);

    expect((await act()).status).toBe(403);
    await settle();

    const rows = await rowsFor("sharing.access.denied");
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(delegate.id);
    expect(rows[0].actorUserId).toBeNull();
  });
});

describe("delegated reads coalesce to one row a day", () => {
  it("writes one row for many reads, and counts them", async () => {
    const { owner, delegate } = await household();

    await act();
    await act();
    await act();
    await settle();

    const rows = await rowsFor(DELEGATED_ACCESS_ACTION);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(owner.id);
    expect(rows[0].actorUserId).toBe(delegate.id);
    expect(JSON.parse(rows[0].details!)).toEqual({ accesses: 3 });
  });

  it("keeps a second delegate's reads on their own row", async () => {
    // Coalescing is per (owner, delegate, day). Two delegates in one record on
    // one day are two rows — merging them would answer "somebody was in your
    // record" when the owner asked "who".
    const { owner, delegate } = await household();
    const second = await makeUser("second");
    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: second.id,
      access: "READ",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: second.id });

    await act();
    const secondSession = await signIn(second.id);
    await switchSessionTo(secondSession.id, owner.id);
    await act();
    await settle();

    const rows = await rowsFor(DELEGATED_ACCESS_ACTION);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.actorUserId).sort()).toEqual(
      [delegate.id, second.id].sort(),
    );
    expect(rows.every((r) => r.userId === owner.id)).toBe(true);
  });

  it("starts a new row on the next day", async () => {
    const { owner, delegate } = await household();

    await act();
    await settle();

    // Age today's row by a day. The coalescing key is the row's own date, so
    // this is exactly what tomorrow looks like to the next read — and if the
    // key were "the latest row" rather than the day, the next read would still
    // find this one and the trail would grow one row per delegate forever.
    await getPrismaClient().$executeRaw`
      UPDATE audit_logs
      SET created_at = created_at - INTERVAL '1 day'
      WHERE action = ${DELEGATED_ACCESS_ACTION}
    `;

    await act();
    await settle();

    const rows = await rowsFor(DELEGATED_ACCESS_ACTION);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.userId === owner.id)).toBe(true);
    expect(rows.every((r) => r.actorUserId === delegate.id)).toBe(true);
  });

  it("writes nothing at all when nobody is delegating", async () => {
    const solo = await makeUser("solo");
    await signIn(solo.id);

    await act();
    await settle();

    expect(await rowsFor(DELEGATED_ACCESS_ACTION)).toHaveLength(0);
  });
});

describe("the lifecycle verbs leave their own trail", () => {
  it("records the invitation, the acceptance and the revocation", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");

    await signIn(owner.id);
    const { POST } = await import("@/app/api/account/grants/route");
    const invited = await POST(
      new NextRequest("http://localhost/api/account/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: delegate.username }),
      }),
    );
    const grantId = (await invited.json()).data.id;

    await signIn(delegate.id);
    const accept = await import("@/app/api/account/grants/[id]/accept/route");
    await accept.POST(
      new NextRequest(`http://localhost/api/account/grants/${grantId}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: grantId }) },
    );

    await signIn(owner.id);
    const revokeRoute = await import("@/app/api/account/grants/[id]/route");
    await revokeRoute.DELETE(
      new NextRequest(`http://localhost/api/account/grants/${grantId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: grantId }) },
    );

    const trail = await getPrismaClient().auditLog.findMany({
      where: { action: { startsWith: "sharing.grant." } },
      orderBy: { createdAt: "asc" },
    });
    expect(trail.map((r) => r.action)).toEqual([
      "sharing.grant.invited",
      "sharing.grant.accepted",
      "sharing.grant.revoked",
    ]);
    // Each row files under whoever performed it, acting as themselves. The
    // owner's side of the acceptance is not an audit row at all — it is
    // `acceptedAt` on the grant, which is the durable consent record.
    expect(trail.map((r) => r.userId)).toEqual([
      owner.id,
      delegate.id,
      owner.id,
    ]);
    expect(trail.every((r) => r.actorUserId === null)).toBe(true);
  });
});
