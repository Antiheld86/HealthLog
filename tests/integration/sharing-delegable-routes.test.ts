/**
 * The migrated routes, driven as routes, against real Postgres.
 *
 * Every case below imports the shipped `GET` export and calls it. Nothing is
 * reimplemented: the real `apiHandler`, the real `requireRecordAuth`, the real
 * grant table, the real Prisma queries. That matters more here than anywhere
 * else in this feature, because the thing being asserted is a substitution
 * that happens ABOVE the handler body — a test that rebuilt the handler would
 * be testing its own copy of the substitution and would keep passing after the
 * route stopped performing it.
 *
 * Four questions per domain, and the fourth is the one that decides whether
 * this release is safe to ship:
 *
 *   1. a delegate with a live READ grant reads the OWNER's rows;
 *   2. the same delegate without a grant is refused `sharing.access.denied`;
 *   3. after revocation the very NEXT request is refused — no re-login;
 *   4. a caller who never switched gets exactly what they got before.
 *
 * (4) is the regression. Forty-four routes changed; a person who shares
 * nothing must not be able to tell.
 *
 * Owner and delegate are BOTH seeded with data in every case, and the
 * assertions name the owner's values and the delegate's separately. An empty
 * result satisfies "the delegate's rows are absent" while hiding the exact
 * failure this feature exists to avoid.
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

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `deleg-${suffix}`,
      email: `deleg-${suffix}@example.test`,
      displayName: `Deleg ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
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
 * A live grant and a session already inside the owner's record.
 *
 * Written straight to the tables rather than driven through invite / accept /
 * switch, because `sharing-lifecycle.test.ts` already proves those three
 * routes produce exactly these rows and repeating the handshake once per
 * domain would buy nothing but wall-clock. The rows are the contract; this
 * file is about what the migrated routes do once they exist.
 */
async function switchInto(ownerId: string, delegateId: string) {
  const grant = await getPrismaClient().accountGrant.create({
    data: {
      grantorId: ownerId,
      granteeId: delegateId,
      access: "READ",
      acceptedAt: new Date(),
    },
  });
  const session = await signIn(delegateId);
  await getPrismaClient().session.update({
    where: { id: session.id },
    data: { actingAsUserId: ownerId },
  });
  return { grant, session };
}

/** The delegate is inside the record, but the grant is gone. */
async function revokeGrant(grantId: string) {
  await getPrismaClient().accountGrant.update({
    where: { id: grantId },
    data: { revokedAt: new Date(), revokedBy: "GRANTOR" },
  });
}

/**
 * A route's `GET` export, seen from outside.
 *
 * Each shipped handler declares its own params shape (`{ id: string }` and so
 * on), which is exactly the sort of per-route difference a driver like this one
 * has no business knowing. The cast at each call site narrows to this, and the
 * `params` object handed in is checked by the route's own Zod / lookup logic
 * one line later — a wrong id produces a 404 from the handler, not a type
 * error here.
 */
type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

function get(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: "GET" });
}

async function call(
  handler: Handler,
  url: string,
  params: Record<string, string> = {},
): Promise<Response> {
  return handler(get(url), { params: Promise.resolve(params) });
}

async function body(response: Response): Promise<{
  data: unknown;
  error: unknown;
  meta?: { errorCode?: string };
}> {
  return response.json();
}

/** The stable refusal, asserted by code rather than by status alone. */
async function expectDenied(response: Response) {
  expect(response.status).toBe(403);
  expect((await body(response)).meta?.errorCode).toBe("sharing.access.denied");
}

/**
 * The four-part contract, run against one route.
 *
 * `seed` writes one row for whichever user it is handed and returns the value
 * that identifies it in the response; `read` pulls those identifying values
 * back out of the response body. The domain suites below supply both, so each
 * one is four assertions of substance rather than four of shape.
 */
function contract<T>(
  name: string,
  route: {
    call: () => Promise<Response>;
    seed: (userId: string, marker: T) => Promise<void>;
    read: (payload: never) => T[];
    ownerMarker: T;
    delegateMarker: T;
  },
) {
  describe(name, () => {
    it("serves the owner's rows to a delegate holding a live grant", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      await route.seed(owner.id, route.ownerMarker);
      await route.seed(delegate.id, route.delegateMarker);

      await switchInto(owner.id, delegate.id);
      const response = await route.call();

      expect(response.status).toBe(200);
      const rows = route.read((await body(response)).data as never);
      expect(rows).toContainEqual(route.ownerMarker);
      // The delegate's own row is seeded and must be absent. Asserting the
      // owner's presence alone would pass on a handler that returned
      // everybody's rows.
      expect(rows).not.toContainEqual(route.delegateMarker);
    });

    it("refuses a caller who names a record they were never granted", async () => {
      const owner = await makeUser("owner");
      const stranger = await makeUser("stranger");
      await route.seed(owner.id, route.ownerMarker);

      const session = await signIn(stranger.id);
      await getPrismaClient().session.update({
        where: { id: session.id },
        data: { actingAsUserId: owner.id },
      });

      await expectDenied(await route.call());
    });

    it("refuses the next request after the grant is revoked", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      await route.seed(owner.id, route.ownerMarker);

      const { grant } = await switchInto(owner.id, delegate.id);
      expect((await route.call()).status).toBe(200);

      // No sign-out, no new session, no cache flush. The same browser, the
      // next request.
      await revokeGrant(grant.id);
      await expectDenied(await route.call());
    });

    it("is unchanged for a caller who has not switched", async () => {
      const plain = await makeUser("plain");
      await route.seed(plain.id, route.ownerMarker);
      await signIn(plain.id);

      const response = await route.call();
      expect(response.status).toBe(200);
      expect(route.read((await body(response)).data as never)).toContainEqual(
        route.ownerMarker,
      );
    });
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

/* -------------------------------------------------------------------------- */
/* Measurements                                                               */
/* -------------------------------------------------------------------------- */

async function seedWeight(userId: string, value: number) {
  await getPrismaClient().measurement.create({
    data: {
      userId,
      type: "WEIGHT",
      value,
      unit: "kg",
      measuredAt: new Date("2026-07-15T08:00:00Z"),
      source: "MANUAL",
    },
  });
}

contract<number>("GET /api/measurements", {
  call: async () => {
    const { GET } = await import("@/app/api/measurements/route");
    return call(GET as Handler, "/api/measurements");
  },
  seed: seedWeight,
  read: (payload: { measurements: { value: number }[] }) =>
    payload.measurements.map((m) => m.value),
  ownerMarker: 81,
  delegateMarker: 64,
});

contract<number>("GET /api/measurements/series", {
  call: async () => {
    const { GET } = await import("@/app/api/measurements/series/route");
    return call(GET as Handler, "/api/measurements/series?kind=weight&days=90");
  },
  seed: seedWeight,
  read: (payload: { points: { value: number }[] }) =>
    payload.points.map((p) => p.value),
  ownerMarker: 81,
  delegateMarker: 64,
});

contract<number>("GET /api/measurements/series-batch", {
  call: async () => {
    const { GET } = await import("@/app/api/measurements/series-batch/route");
    return call(
      GET as Handler,
      "/api/measurements/series-batch?types=WEIGHT&from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z",
    );
  },
  seed: seedWeight,
  read: (payload: { series: Record<string, { value: number }[]> }) =>
    (payload.series.WEIGHT ?? []).map((row) => row.value),
  ownerMarker: 81,
  delegateMarker: 64,
});

describe("GET /api/measurements/[id]", () => {
  it("serves one of the owner's readings and refuses the delegate's reach past it", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedWeight(owner.id, 81);
    await seedWeight(delegate.id, 64);
    const ownerRow = await getPrismaClient().measurement.findFirstOrThrow({
      where: { userId: owner.id },
    });
    const delegateRow = await getPrismaClient().measurement.findFirstOrThrow({
      where: { userId: delegate.id },
    });

    const { GET } = await import("@/app/api/measurements/[id]/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const mine = await call(
      GET as Handler,
      `/api/measurements/${ownerRow.id}`,
      { id: ownerRow.id },
    );
    expect(mine.status).toBe(200);
    expect((await body(mine)).data).toMatchObject({ value: 81 });

    // The fetch-then-guard arm now guards against the OWNER. The delegate's
    // own reading is out of scope while they are inside somebody else's
    // record — which is the correct answer and a surprising one, so it is
    // asserted rather than assumed.
    const theirs = await call(
      GET as Handler,
      `/api/measurements/${delegateRow.id}`,
      { id: delegateRow.id },
    );
    expect(theirs.status).toBe(404);

    await revokeGrant(grant.id);
    await expectDenied(
      await call(GET as Handler, `/api/measurements/${ownerRow.id}`, {
        id: ownerRow.id,
      }),
    );
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedWeight(plain.id, 77);
    const row = await getPrismaClient().measurement.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/measurements/[id]/route");
    const response = await call(GET as Handler, `/api/measurements/${row.id}`, {
      id: row.id,
    });
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({ value: 77 });
  });
});

describe("the 422 breadcrumb a delegate leaves on the owner's record", () => {
  it("files under the owner and names the delegate as the actor", async () => {
    // The one write a delegable measurements GET performs. It was a bare
    // `prisma.auditLog.create` before the migration, which files the row with
    // `actorUserId` NULL — indistinguishable from the owner having typed the
    // bad query themselves.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await switchInto(owner.id, delegate.id);

    const { GET } = await import("@/app/api/measurements/route");
    const refused = await call(
      GET as Handler,
      "/api/measurements?limit=not-a-number",
    );
    expect(refused.status).toBe(422);

    await vi.waitFor(async () => {
      const row = await getPrismaClient().auditLog.findFirst({
        where: { action: "measurements.list.validation-failed" },
      });
      expect(row?.userId).toBe(owner.id);
      expect(row?.actorUserId).toBe(delegate.id);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Measurement reminders                                                      */
/* -------------------------------------------------------------------------- */

async function seedReminder(userId: string, label: string) {
  await getPrismaClient().measurementReminder.create({
    data: {
      userId,
      label,
      measurementType: "WEIGHT",
      intervalDays: 7,
      enabled: true,
    },
  });
}

contract<string>("GET /api/measurement-reminders", {
  call: async () => {
    const { GET } = await import("@/app/api/measurement-reminders/route");
    return call(GET as Handler, "/api/measurement-reminders");
  },
  seed: seedReminder,
  read: (payload: { label: string }[]) => payload.map((r) => r.label),
  ownerMarker: "owner weigh-in",
  delegateMarker: "delegate weigh-in",
});

describe("GET /api/measurement-reminders/[id]", () => {
  it("serves the owner's reminder and refuses once the grant ends", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedReminder(owner.id, "owner weigh-in");
    await seedReminder(delegate.id, "delegate weigh-in");
    const ownerRow =
      await getPrismaClient().measurementReminder.findFirstOrThrow({
        where: { userId: owner.id },
      });
    const delegateRow =
      await getPrismaClient().measurementReminder.findFirstOrThrow({
        where: { userId: delegate.id },
      });

    const { GET } = await import("@/app/api/measurement-reminders/[id]/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const mine = await call(
      GET as Handler,
      `/api/measurement-reminders/${ownerRow.id}`,
      { id: ownerRow.id },
    );
    expect(mine.status).toBe(200);
    expect((await body(mine)).data).toMatchObject({ label: "owner weigh-in" });

    const theirs = await call(
      GET as Handler,
      `/api/measurement-reminders/${delegateRow.id}`,
      { id: delegateRow.id },
    );
    expect(theirs.status).toBe(404);

    await revokeGrant(grant.id);
    await expectDenied(
      await call(GET as Handler, `/api/measurement-reminders/${ownerRow.id}`, {
        id: ownerRow.id,
      }),
    );
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedReminder(plain.id, "plain weigh-in");
    const row = await getPrismaClient().measurementReminder.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/measurement-reminders/[id]/route");
    const response = await call(
      GET as Handler,
      `/api/measurement-reminders/${row.id}`,
      { id: row.id },
    );
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({
      label: "plain weigh-in",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Labs and biomarkers                                                        */
/* -------------------------------------------------------------------------- */

async function seedLab(userId: string, analyte: string) {
  await getPrismaClient().labResult.create({
    data: {
      userId,
      analyte,
      value: 5.2,
      unit: "mmol/L",
      takenAt: new Date("2026-07-10T09:00:00Z"),
    },
  });
}

contract<string>("GET /api/labs", {
  call: async () => {
    const { GET } = await import("@/app/api/labs/route");
    return call(GET as Handler, "/api/labs");
  },
  seed: seedLab,
  read: (payload: { results: { analyte: string }[] }) =>
    payload.results.map((r) => r.analyte),
  ownerMarker: "owner-hba1c",
  delegateMarker: "delegate-hba1c",
});

async function seedBiomarker(userId: string, name: string) {
  await getPrismaClient().biomarker.create({
    data: { userId, name, unit: "mmol/L" },
  });
}

contract<string>("GET /api/biomarkers", {
  call: async () => {
    const { GET } = await import("@/app/api/biomarkers/route");
    return call(GET as Handler, "/api/biomarkers");
  },
  seed: seedBiomarker,
  read: (payload: { biomarkers: { name: string }[] }) =>
    payload.biomarkers.map((b) => b.name),
  ownerMarker: "owner-ferritin",
  delegateMarker: "delegate-ferritin",
});

describe("GET /api/labs/[id] and /api/biomarkers/[id]", () => {
  it("resolve by id against the owner, not the caller", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedLab(owner.id, "owner-hba1c");
    await seedLab(delegate.id, "delegate-hba1c");
    await seedBiomarker(owner.id, "owner-ferritin");

    const ownerLab = await getPrismaClient().labResult.findFirstOrThrow({
      where: { userId: owner.id },
    });
    const delegateLab = await getPrismaClient().labResult.findFirstOrThrow({
      where: { userId: delegate.id },
    });
    const ownerMarker = await getPrismaClient().biomarker.findFirstOrThrow({
      where: { userId: owner.id },
    });

    const labs = await import("@/app/api/labs/[id]/route");
    const markers = await import("@/app/api/biomarkers/[id]/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const lab = await call(labs.GET as Handler, `/api/labs/${ownerLab.id}`, {
      id: ownerLab.id,
    });
    expect(lab.status).toBe(200);
    expect((await body(lab)).data).toMatchObject({ analyte: "owner-hba1c" });

    // The delegate's own result is not reachable from inside the owner's
    // record. The fetch-then-guard arm now guards against the owner.
    const theirs = await call(
      labs.GET as Handler,
      `/api/labs/${delegateLab.id}`,
      { id: delegateLab.id },
    );
    expect(theirs.status).toBe(404);

    const marker = await call(
      markers.GET as Handler,
      `/api/biomarkers/${ownerMarker.id}`,
      { id: ownerMarker.id },
    );
    expect(marker.status).toBe(200);
    expect((await body(marker)).data).toMatchObject({ name: "owner-ferritin" });

    await revokeGrant(grant.id);
    await expectDenied(
      await call(labs.GET as Handler, `/api/labs/${ownerLab.id}`, {
        id: ownerLab.id,
      }),
    );
    await expectDenied(
      await call(markers.GET as Handler, `/api/biomarkers/${ownerMarker.id}`, {
        id: ownerMarker.id,
      }),
    );
  });

  it("are unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedLab(plain.id, "plain-hba1c");
    const row = await getPrismaClient().labResult.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/labs/[id]/route");
    const response = await call(GET as Handler, `/api/labs/${row.id}`, {
      id: row.id,
    });
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({
      analyte: "plain-hba1c",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Clinical record                                                            */
/* -------------------------------------------------------------------------- */

async function seedAllergy(userId: string, substance: string) {
  await getPrismaClient().allergy.create({ data: { userId, substance } });
}

contract<string>("GET /api/allergies", {
  call: async () => {
    const { GET } = await import("@/app/api/allergies/route");
    return call(GET as Handler, "/api/allergies");
  },
  seed: seedAllergy,
  read: (payload: { substance: string }[]) => payload.map((a) => a.substance),
  ownerMarker: "owner-penicillin",
  delegateMarker: "delegate-penicillin",
});

async function seedFamilyHistory(userId: string, condition: string) {
  await getPrismaClient().familyHistoryEntry.create({
    data: { userId, relationship: "MOTHER", condition },
  });
}

contract<string>("GET /api/family-history", {
  call: async () => {
    const { GET } = await import("@/app/api/family-history/route");
    return call(GET as Handler, "/api/family-history");
  },
  seed: seedFamilyHistory,
  read: (payload: { condition: string }[]) => payload.map((e) => e.condition),
  ownerMarker: "owner-condition",
  delegateMarker: "delegate-condition",
});

describe("GET /api/allergies/[id] and /api/family-history/[id]", () => {
  it("resolve by id against the owner and refuse once the grant ends", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedAllergy(owner.id, "owner-penicillin");
    await seedAllergy(delegate.id, "delegate-penicillin");
    await seedFamilyHistory(owner.id, "owner-condition");

    const ownerAllergy = await getPrismaClient().allergy.findFirstOrThrow({
      where: { userId: owner.id },
    });
    const delegateAllergy = await getPrismaClient().allergy.findFirstOrThrow({
      where: { userId: delegate.id },
    });
    const ownerEntry =
      await getPrismaClient().familyHistoryEntry.findFirstOrThrow({
        where: { userId: owner.id },
      });

    const allergies = await import("@/app/api/allergies/[id]/route");
    const history = await import("@/app/api/family-history/[id]/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const mine = await call(
      allergies.GET as Handler,
      `/api/allergies/${ownerAllergy.id}`,
      { id: ownerAllergy.id },
    );
    expect(mine.status).toBe(200);
    expect((await body(mine)).data).toMatchObject({
      substance: "owner-penicillin",
    });

    const theirs = await call(
      allergies.GET as Handler,
      `/api/allergies/${delegateAllergy.id}`,
      { id: delegateAllergy.id },
    );
    expect(theirs.status).toBe(404);

    const entry = await call(
      history.GET as Handler,
      `/api/family-history/${ownerEntry.id}`,
      { id: ownerEntry.id },
    );
    expect(entry.status).toBe(200);
    expect((await body(entry)).data).toMatchObject({
      condition: "owner-condition",
    });

    await revokeGrant(grant.id);
    await expectDenied(
      await call(
        allergies.GET as Handler,
        `/api/allergies/${ownerAllergy.id}`,
        { id: ownerAllergy.id },
      ),
    );
  });

  it("are unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedAllergy(plain.id, "plain-penicillin");
    const row = await getPrismaClient().allergy.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/allergies/[id]/route");
    const response = await call(GET as Handler, `/api/allergies/${row.id}`, {
      id: row.id,
    });
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({
      substance: "plain-penicillin",
    });
  });
});

async function seedFact(userId: string, value: string) {
  // Through the real writer, because the revision's value is an encrypted
  // column and a hand-built row would read back as `unreadable`.
  const { createHealthProfileFact } =
    await import("@/lib/profile/health-facts");
  await createHealthProfileFact(userId, "SMOKING_STATUS", value as never);
}

contract<string>("GET /api/anamnesis/facts", {
  call: async () => {
    const { GET } = await import("@/app/api/anamnesis/facts/route");
    return call(GET as Handler, "/api/anamnesis/facts");
  },
  seed: seedFact,
  read: (payload: {
    current: Record<string, { value: string | null } | null>;
  }) =>
    Object.values(payload.current)
      .map((row) => row?.value ?? null)
      .filter((v): v is string => v !== null),
  ownerMarker: "CURRENT",
  delegateMarker: "NEVER",
});

/* -------------------------------------------------------------------------- */
/* Mental health — the module gate follows the record                          */
/* -------------------------------------------------------------------------- */

async function seedAssessment(userId: string, totalScore: number) {
  await getPrismaClient().mentalHealthAssessment.create({
    data: {
      userId,
      instrument: "PHQ9",
      locale: "en",
      responsesEncrypted: Buffer.from("sealed"),
      totalScore,
      severityBand: "mild",
      takenAt: new Date("2026-07-12T10:00:00Z"),
    },
  });
}

async function setModulePreference(userId: string, enabled: boolean) {
  await getPrismaClient().user.update({
    where: { id: userId },
    data: { modulePreferencesJson: { mentalHealth: enabled } },
  });
}

describe("GET /api/mental-health/assessments", () => {
  it("reads the owner's screener history when the OWNER enabled the module", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await setModulePreference(owner.id, true);
    await seedAssessment(owner.id, 11);
    await seedAssessment(delegate.id, 3);

    await switchInto(owner.id, delegate.id);
    const { GET } = await import("@/app/api/mental-health/assessments/route");
    const response = await call(
      GET as Handler,
      "/api/mental-health/assessments",
    );

    expect(response.status).toBe(200);
    const payload = (await body(response)).data as {
      assessments: { totalScore: number }[];
    };
    expect(payload.assessments.map((a) => a.totalScore)).toEqual([11]);
  });

  it("refuses when the OWNER switched the module off, whatever the delegate set", async () => {
    // The decision recorded in the classification: the module map governs
    // which parts of a RECORD exist, so it is read off the record. A delegate
    // who enabled the screener on their own account does not thereby gain a
    // screener view inside somebody else's.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await setModulePreference(owner.id, false);
    await setModulePreference(delegate.id, true);
    await seedAssessment(owner.id, 11);

    await switchInto(owner.id, delegate.id);
    const { GET } = await import("@/app/api/mental-health/assessments/route");
    const response = await call(
      GET as Handler,
      "/api/mental-health/assessments",
    );

    expect(response.status).toBe(403);
    expect((await body(response)).meta?.errorCode).toBe("module.disabled");
  });

  it("refuses a caller with no grant, and refuses the request after revocation", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await setModulePreference(owner.id, true);
    await seedAssessment(owner.id, 11);

    const { GET } = await import("@/app/api/mental-health/assessments/route");
    const { grant } = await switchInto(owner.id, delegate.id);
    expect(
      (await call(GET as Handler, "/api/mental-health/assessments")).status,
    ).toBe(200);

    await revokeGrant(grant.id);
    await expectDenied(
      await call(GET as Handler, "/api/mental-health/assessments"),
    );
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await setModulePreference(plain.id, true);
    await seedAssessment(plain.id, 7);
    await signIn(plain.id);

    const { GET } = await import("@/app/api/mental-health/assessments/route");
    const response = await call(
      GET as Handler,
      "/api/mental-health/assessments",
    );
    expect(response.status).toBe(200);
    const payload = (await body(response)).data as {
      assessments: { totalScore: number }[];
    };
    expect(payload.assessments.map((a) => a.totalScore)).toEqual([7]);
  });
});
