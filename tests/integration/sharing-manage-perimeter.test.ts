/**
 * v1.37.0 — the MANAGE perimeter, driven as routes against real Postgres.
 *
 * MANAGE is the level where a delegate stops adding to somebody's record and
 * starts changing it. Seventy modules answer at it; forty-three of them can
 * destroy or rewrite something. The structural guard freezes WHICH routes say
 * `"manage"` and, since this release, freezes the conditions each admission
 * was granted on — but a frozen tag is a promise about code, not about
 * behaviour, and the promises here are the kind that fail quietly: an audit
 * row that names an id and nothing else, a rate bucket keyed on the wrong
 * person, a navigation that spends the owner's AI budget.
 *
 * So this file drives the shipped exports. Same construction as
 * `sharing-delegable-writes.test.ts`: the real `apiHandler`, the real
 * `requireRecordAuth`, the real grant table, the real Prisma writes. The grant
 * is minted through `inviteGrant` + `acceptGrant` because "a MANAGE grant
 * exists" and "a MANAGE grant can be created by the flow this release ships"
 * are different claims.
 *
 * Four legs per verb, then the conditions:
 *
 *   1. a manager with a live MANAGE grant changes the OWNER's record, and the
 *      audit row carries `userId = owner` AND `actorUserId = manager`;
 *   2. the same person under a WRITE grant is refused, and nothing moved —
 *      asserted by re-reading the row, not by the status alone;
 *   3. a caller who was never granted anything is refused the same way;
 *   4. a caller who has not switched gets exactly what they always got.
 *
 * The conditions each get their own test, and each is written so that removing
 * the implementation turns it red rather than leaving it green with a smaller
 * claim: the reconstruction legs read the audit `details` and assert the
 * VALUES, the scope leg reads the rate-limit table and asserts the key, and
 * the generation leg asserts both halves — nothing enqueued for the manager,
 * something enqueued for the owner doing the identical thing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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

/**
 * The narrative warm, stubbed at the seam the condition is about.
 *
 * C5 is the condition that costs the owner money when it is wrong, and what it
 * suppresses is an ENQUEUE — a pg-boss insert whose absence is invisible from
 * the response. Counting the calls is the only way to see it, and the count
 * has to be taken on both sides: zero for the manager is worth nothing unless
 * the same request by the owner is one.
 */
const enqueueNarrativeWarm = vi.fn(async (_payload: unknown) => {});
vi.mock("@/lib/jobs/period-narrative-shared", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/jobs/period-narrative-shared")>();
  return {
    ...actual,
    enqueueNarrativeWarm: (payload: unknown) => enqueueNarrativeWarm(payload),
  };
});

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `mg-${suffix}`,
      email: `mg-${suffix}@example.test`,
      displayName: `MG ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
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

/** A live grant at the named level, accepted, the caller switched into it. */
async function switchInto(
  ownerId: string,
  delegateId: string,
  access: "READ" | "WRITE" | "MANAGE",
) {
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: ownerId,
    granteeId: delegateId,
    access,
    scope: null,
  });
  const grant = await acceptGrant({
    grantId: invited.id,
    granteeId: delegateId,
  });
  expect(grant.access).toBe(access);
  expect(grant.acceptedAt).not.toBeNull();

  const session = await signIn(delegateId);
  await getPrismaClient().session.update({
    where: { id: session.id },
    data: { actingAsUserId: ownerId },
  });
  return { grant, session };
}

/** A session inside a record nobody ever shared with this caller. */
async function claimWithoutGrant(ownerId: string, callerId: string) {
  const session = await signIn(callerId);
  await getPrismaClient().session.update({
    where: { id: session.id },
    data: { actingAsUserId: ownerId },
  });
}

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

function request(method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(
  handler: Handler,
  method: string,
  url: string,
  body?: unknown,
  params: Record<string, string> = {},
): Promise<Response> {
  return handler(request(method, url, body), {
    params: Promise.resolve(params),
  });
}

async function payload(response: Response): Promise<{
  data: unknown;
  error: unknown;
  meta?: { errorCode?: string };
}> {
  return response.json();
}

/** The stable refusal, asserted by code rather than by status alone. */
async function expectDenied(response: Response) {
  expect(response.status).toBe(403);
  expect((await payload(response)).meta?.errorCode).toBe(
    "sharing.access.denied",
  );
}

/** The audit row a verb filed, with its details already parsed. */
async function auditRow(action: string) {
  const row = await getPrismaClient().auditLog.findFirst({
    where: { action },
    orderBy: { createdAt: "desc" },
  });
  expect(row, `no ${action} row was written`).not.toBeNull();
  return {
    row: row!,
    details: JSON.parse(row!.details ?? "{}") as Record<string, unknown>,
  };
}

const ISO = "2026-07-15T08:00:00.000Z";

/* -------------------------------------------------------------------------- */
/* The shape of a MANAGE case                                                 */
/* -------------------------------------------------------------------------- */

interface ManageCase<C> {
  /** Rows the verb acts on, created under the record it will change. */
  prepare: (recordOwnerId: string) => Promise<C>;
  /** Drive the shipped export against the current session. */
  act: (ctx: C) => Promise<Response>;
  /** The status a successful call answers with. */
  ok: number;
  /** The action the happy path files through `auditLog`. */
  auditAction: string;
  /** True once the verb has taken effect on the prepared rows. */
  applied: (ctx: C) => Promise<boolean>;
}

function manageContract<C>(name: string, c: ManageCase<C>) {
  describe(name, () => {
    it("changes the owner's record and names the manager as actor", async () => {
      const owner = await makeUser("owner");
      const manager = await makeUser("manager");
      const ctx = await c.prepare(owner.id);

      await switchInto(owner.id, manager.id, "MANAGE");
      const response = await c.act(ctx);
      expect(response.status).toBe(c.ok);

      // The change landed…
      expect(await c.applied(ctx)).toBe(true);
      // …and the trail says who made it, under whose record.
      const { row } = await auditRow(c.auditAction);
      expect(row.userId).toBe(owner.id);
      expect(row.actorUserId).toBe(manager.id);
    });

    it("refuses a WRITE grant, and nothing moves", async () => {
      const owner = await makeUser("owner");
      const helper = await makeUser("helper");
      const ctx = await c.prepare(owner.id);

      await switchInto(owner.id, helper.id, "WRITE");
      await expectDenied(await c.act(ctx));

      // The mutation-check rule: assert it did NOT apply, by re-reading.
      expect(await c.applied(ctx)).toBe(false);
    });

    it("refuses a caller who names a record they were never granted", async () => {
      const owner = await makeUser("owner");
      const stranger = await makeUser("stranger");
      const ctx = await c.prepare(owner.id);

      await claimWithoutGrant(owner.id, stranger.id);
      await expectDenied(await c.act(ctx));
      expect(await c.applied(ctx)).toBe(false);
    });

    it("is unchanged for a caller who has not switched", async () => {
      const plain = await makeUser("plain");
      const ctx = await c.prepare(plain.id);
      await signIn(plain.id);

      expect((await c.act(ctx)).status).toBe(c.ok);
      expect(await c.applied(ctx)).toBe(true);

      const { row } = await auditRow(c.auditAction);
      expect(row.userId).toBe(plain.id);
      expect(row.actorUserId).toBeNull();
    });
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  enqueueNarrativeWarm.mockClear();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

async function makeMeasurement(userId: string, value = 80) {
  // The timestamp moves per row: `(userId, type, measuredAt, source,
  // sleepStage)` is unique, so two fixtures on the same instant collide.
  const measuredAt = new Date(Date.parse(ISO) + counter++ * 60_000);
  return getPrismaClient().measurement.create({
    data: {
      userId,
      type: "WEIGHT",
      value,
      unit: "kg",
      measuredAt,
      source: "MANUAL",
    },
  });
}

async function makeLabResult(userId: string) {
  return getPrismaClient().labResult.create({
    data: {
      userId,
      analyte: "HbA1c",
      value: 5.2,
      unit: "%",
      takenAt: new Date(ISO),
    },
  });
}

async function makeAllergy(userId: string) {
  return getPrismaClient().allergy.create({
    data: {
      userId,
      substance: "Penicillin",
      category: "MEDICATION",
      type: "ALLERGY",
      severity: "SEVERE",
      status: "ACTIVE",
      onsetAt: new Date("2020-03-01T00:00:00.000Z"),
    },
  });
}

async function makeReminder(userId: string) {
  return getPrismaClient().measurementReminder.create({
    data: {
      userId,
      label: "Colonoscopy recall",
      measurementType: null,
      intervalDays: 365,
      notifyHour: 9,
      nextDueAt: new Date("2027-03-01T08:00:00.000Z"),
      enabled: true,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* 1 — the four legs, one verb per domain family                              */
/* -------------------------------------------------------------------------- */

manageContract("PUT /api/measurements/[id]", {
  prepare: (ownerId) => makeMeasurement(ownerId),
  act: async (row) => {
    const { PUT } = await import("@/app/api/measurements/[id]/route");
    return call(
      PUT as Handler,
      "PUT",
      `/api/measurements/${row.id}`,
      {
        value: 74.5,
      },
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "measurement.update",
  applied: async (row) => {
    const after = await getPrismaClient().measurement.findUnique({
      where: { id: row.id },
    });
    return after?.value === 74.5;
  },
});

manageContract("DELETE /api/measurements/[id]", {
  prepare: (ownerId) => makeMeasurement(ownerId),
  act: async (row) => {
    const { DELETE } = await import("@/app/api/measurements/[id]/route");
    return call(
      DELETE as Handler,
      "DELETE",
      `/api/measurements/${row.id}`,
      undefined,
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "measurement.delete",
  applied: async (row) => {
    const after = await getPrismaClient().measurement.findUnique({
      where: { id: row.id },
    });
    return after?.deletedAt !== null;
  },
});

manageContract("PUT /api/labs/[id]", {
  prepare: (ownerId) => makeLabResult(ownerId),
  act: async (row) => {
    const { PUT } = await import("@/app/api/labs/[id]/route");
    return call(
      PUT as Handler,
      "PUT",
      `/api/labs/${row.id}`,
      { value: 6.1 },
      {
        id: row.id,
      },
    );
  },
  ok: 200,
  auditAction: "labResult.update",
  applied: async (row) => {
    const after = await getPrismaClient().labResult.findUnique({
      where: { id: row.id },
    });
    return after?.value === 6.1;
  },
});

manageContract("PATCH /api/allergies/[id]", {
  prepare: (ownerId) => makeAllergy(ownerId),
  act: async (row) => {
    const { PATCH } = await import("@/app/api/allergies/[id]/route");
    return call(
      PATCH as Handler,
      "PATCH",
      `/api/allergies/${row.id}`,
      { severity: "MILD" },
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "allergy.update",
  applied: async (row) => {
    const after = await getPrismaClient().allergy.findUnique({
      where: { id: row.id },
    });
    return after?.severity === "MILD";
  },
});

manageContract("DELETE /api/measurement-reminders/[id]", {
  prepare: (ownerId) => makeReminder(ownerId),
  act: async (row) => {
    const { DELETE } =
      await import("@/app/api/measurement-reminders/[id]/route");
    return call(
      DELETE as Handler,
      "DELETE",
      `/api/measurement-reminders/${row.id}`,
      undefined,
      { id: row.id },
    );
  },
  ok: 200,
  auditAction: "measurementReminder.delete",
  applied: async (row) => {
    const after = await getPrismaClient().measurementReminder.findUnique({
      where: { id: row.id },
    });
    return after === null;
  },
});

/* -------------------------------------------------------------------------- */
/* 2 — reconstructable or refused                                             */
/* -------------------------------------------------------------------------- */

describe("what a destruction leaves behind", () => {
  it("C3: a hard delete files what it destroyed, and never the encrypted text", async () => {
    // The preventive-care reminder is the sharpest case in the tree: the row
    // is gone, no restore route reaches it, and the audit row used to say
    // `{ reminderId }` — a pointer at nothing. An owner reading their feed
    // could see that a recall disappeared and never learn what it was for.
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    const reminder = await makeReminder(owner.id);

    await switchInto(owner.id, manager.id, "MANAGE");
    const { DELETE } =
      await import("@/app/api/measurement-reminders/[id]/route");
    expect(
      (
        await call(
          DELETE as Handler,
          "DELETE",
          `/api/measurement-reminders/${reminder.id}`,
          undefined,
          { id: reminder.id },
        )
      ).status,
    ).toBe(200);

    const { details } = await auditRow("measurementReminder.delete");
    expect(details.destroyedModel).toBe("MeasurementReminder");
    expect(details.destroyedId).toBe(reminder.id);
    expect(details.destroyedLabel).toBe("Colonoscopy recall");
    expect(details.destroyedAt).toBe(reminder.nextDueAt?.toISOString());
    expect(details.intervalDays).toBe(365);
  });

  it("C3: the allergy delete carries the allergen and never the reaction", async () => {
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    const allergy = await getPrismaClient().allergy.create({
      data: {
        userId: owner.id,
        substance: "Penicillin",
        category: "MEDICATION",
        type: "ALLERGY",
        severity: "SEVERE",
        status: "ACTIVE",
        onsetAt: new Date("2020-03-01T00:00:00.000Z"),
      },
    });

    await switchInto(owner.id, manager.id, "MANAGE");
    const { DELETE } = await import("@/app/api/allergies/[id]/route");
    expect(
      (
        await call(
          DELETE as Handler,
          "DELETE",
          `/api/allergies/${allergy.id}`,
          undefined,
          { id: allergy.id },
        )
      ).status,
    ).toBe(200);

    const { row, details } = await auditRow("allergy.delete");
    expect(details.destroyedLabel).toBe("Penicillin");
    expect(details.severity).toBe("SEVERE");
    expect(details.destroyedAt).toBe("2020-03-01T00:00:00.000Z");
    // …and the audit table did not become a second store for the encrypted
    // half of the row. Asserted on the raw string, because a nested key would
    // slip past a top-level property check.
    expect(row.details ?? "").not.toContain("reaction");
  });

  it("C4: an edit files the field family and the value that is gone", async () => {
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    const measurement = await makeMeasurement(owner.id, 80);

    await switchInto(owner.id, manager.id, "MANAGE");
    const { PUT } = await import("@/app/api/measurements/[id]/route");
    expect(
      (
        await call(
          PUT as Handler,
          "PUT",
          `/api/measurements/${measurement.id}`,
          { value: 74.5 },
          { id: measurement.id },
        )
      ).status,
    ).toBe(200);

    const { details } = await auditRow("measurement.update");
    expect(details.fields).toEqual(["value"]);
    expect((details.previous as Record<string, unknown>).value).toBe(80);
  });

  it("a restore puts back the row it names, and leaves the others tombstoned", async () => {
    // The fake-that-ignores-its-`where` case: a count check passes on a
    // restore that clears every tombstone in the record. The id is what
    // defeats it.
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    const kept = await makeMeasurement(owner.id, 81);
    const other = await makeMeasurement(owner.id, 82);
    await getPrismaClient().measurement.updateMany({
      where: { id: { in: [kept.id, other.id] } },
      data: { deletedAt: new Date() },
    });

    await switchInto(owner.id, manager.id, "MANAGE");
    const { POST } = await import("@/app/api/measurements/restore/route");
    const response = await call(
      POST as Handler,
      "POST",
      "/api/measurements/restore",
      {
        ids: [kept.id],
      },
    );
    expect(response.status).toBe(200);

    const restored = await getPrismaClient().measurement.findUnique({
      where: { id: kept.id },
    });
    const untouched = await getPrismaClient().measurement.findUnique({
      where: { id: other.id },
    });
    expect(restored?.deletedAt).toBeNull();
    expect(untouched?.deletedAt).not.toBeNull();

    const { row } = await auditRow("measurement.restore");
    expect(row.userId).toBe(owner.id);
    expect(row.actorUserId).toBe(manager.id);
  });
});

/* -------------------------------------------------------------------------- */
/* 3 — the conditions that are not about the audit row                        */
/* -------------------------------------------------------------------------- */

describe("the conditions the admissions were granted on", () => {
  it("C1: the manager burns their own rate allowance, not the owner's", async () => {
    // The buckets live in Postgres, so the key itself is readable. A bucket
    // keyed on the record would let a manager lock the owner out of their own
    // restore button by hammering it.
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    const row = await makeMeasurement(owner.id);
    await getPrismaClient().measurement.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });

    await switchInto(owner.id, manager.id, "MANAGE");
    const { POST } = await import("@/app/api/measurements/restore/route");
    expect(
      (
        await call(POST as Handler, "POST", "/api/measurements/restore", {
          ids: [row.id],
        })
      ).status,
    ).toBe(200);

    const buckets = await getPrismaClient().rateLimit.findMany();
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.some((b) => b.key.includes(manager.id))).toBe(true);
    expect(buckets.some((b) => b.key.includes(owner.id))).toBe(false);
  });

  it("C5: a manager's navigation enqueues no generation; the owner's does", async () => {
    // Both halves, and the second is what makes the first mean anything: the
    // narrative route warms unconditionally, so a zero on the delegated side
    // could just as easily mean the route never reached the enqueue at all.
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    const { GET } = await import("@/app/api/insights/narrative/route");

    await signIn(owner.id);
    expect(
      (await call(GET as Handler, "GET", "/api/insights/narrative?period=week"))
        .status,
    ).toBe(200);
    expect(enqueueNarrativeWarm).toHaveBeenCalledTimes(1);

    enqueueNarrativeWarm.mockClear();

    await switchInto(owner.id, manager.id, "MANAGE");
    const delegated = await call(
      GET as Handler,
      "GET",
      "/api/insights/narrative?period=week",
    );
    expect(delegated.status).toBe(200);
    expect(enqueueNarrativeWarm).not.toHaveBeenCalled();
  });

  it("C5: a WRITE grant cannot read the generated surfaces at all", async () => {
    const owner = await makeUser("owner");
    const helper = await makeUser("helper");
    await switchInto(owner.id, helper.id, "WRITE");

    const { GET } = await import("@/app/api/insights/narrative/route");
    await expectDenied(
      await call(GET as Handler, "GET", "/api/insights/narrative?period=week"),
    );
    expect(enqueueNarrativeWarm).not.toHaveBeenCalled();
  });

  it("C6: the delegated mood create refuses the sync client's externalId", async () => {
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    const body = {
      mood: "GUT",
      moodLoggedAt: ISO,
      // A stable, device-shaped id: the floor on `externalId` refuses an
      // unstable one at the schema, and this test is about the level, not
      // about that floor.
      externalId: "8B0F3C2E-1D4A-4F5B-9C6D-7E8F90A1B2C3",
      source: "MOODLOG",
    };

    await switchInto(owner.id, manager.id, "MANAGE");
    const { POST } = await import("@/app/api/mood-entries/route");
    const refused = await call(
      POST as Handler,
      "POST",
      "/api/mood-entries",
      body,
    );
    expect(refused.status).toBe(422);
    expect((await payload(refused)).meta?.errorCode).toBe(
      "mood.create.external_id_not_delegable",
    );
    expect(
      await getPrismaClient().moodEntry.count({ where: { userId: owner.id } }),
    ).toBe(0);

    // The same body from the owner's own session still lands: C6 closes the
    // delegated branch, not the route.
    await signIn(owner.id);
    const accepted = await call(
      POST as Handler,
      "POST",
      "/api/mood-entries",
      body,
    );
    expect(accepted.status).toBe(201);
    expect(
      await getPrismaClient().moodEntry.count({ where: { userId: owner.id } }),
    ).toBe(1);
  });
});
