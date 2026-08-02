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

/* -------------------------------------------------------------------------- */
/* Mood, custom metrics, personal records                                     */
/* -------------------------------------------------------------------------- */

async function seedMood(userId: string, score: number) {
  await getPrismaClient().moodEntry.create({
    data: {
      userId,
      date: "2026-07-14",
      mood: "GUT",
      score,
      moodLoggedAt: new Date("2026-07-14T19:00:00Z"),
    },
  });
}

contract<number>("GET /api/mood-entries", {
  call: async () => {
    const { GET } = await import("@/app/api/mood-entries/route");
    return call(GET as Handler, "/api/mood-entries");
  },
  seed: seedMood,
  read: (payload: { entries: { score: number }[] }) =>
    payload.entries.map((e) => e.score),
  ownerMarker: 4,
  delegateMarker: 2,
});

describe("GET /api/mood-entries/[id]", () => {
  it("resolves against the owner and refuses once the grant ends", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedMood(owner.id, 4);
    await seedMood(delegate.id, 2);
    const ownerRow = await getPrismaClient().moodEntry.findFirstOrThrow({
      where: { userId: owner.id },
    });
    const delegateRow = await getPrismaClient().moodEntry.findFirstOrThrow({
      where: { userId: delegate.id },
    });

    const { GET } = await import("@/app/api/mood-entries/[id]/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const mine = await call(
      GET as Handler,
      `/api/mood-entries/${ownerRow.id}`,
      { id: ownerRow.id },
    );
    expect(mine.status).toBe(200);
    expect((await body(mine)).data).toMatchObject({ score: 4 });

    const theirs = await call(
      GET as Handler,
      `/api/mood-entries/${delegateRow.id}`,
      { id: delegateRow.id },
    );
    expect(theirs.status).toBe(404);

    await revokeGrant(grant.id);
    await expectDenied(
      await call(GET as Handler, `/api/mood-entries/${ownerRow.id}`, {
        id: ownerRow.id,
      }),
    );
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedMood(plain.id, 5);
    const row = await getPrismaClient().moodEntry.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/mood-entries/[id]/route");
    const response = await call(GET as Handler, `/api/mood-entries/${row.id}`, {
      id: row.id,
    });
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({ score: 5 });
  });
});

async function seedCustomMetric(userId: string, name: string) {
  const metric = await getPrismaClient().customMetric.create({
    data: { userId, name, unit: "ml" },
  });
  await getPrismaClient().customMetricEntry.create({
    data: {
      userId,
      customMetricId: metric.id,
      value: 250,
      unit: "ml",
      measuredAt: new Date("2026-07-14T12:00:00Z"),
    },
  });
}

contract<string>("GET /api/custom-metrics", {
  call: async () => {
    const { GET } = await import("@/app/api/custom-metrics/route");
    return call(GET as Handler, "/api/custom-metrics");
  },
  seed: seedCustomMetric,
  read: (payload: { customMetrics: { name: string }[] }) =>
    payload.customMetrics.map((m) => m.name),
  ownerMarker: "owner-water",
  delegateMarker: "delegate-water",
});

describe("GET /api/custom-metrics/[id] and its entries", () => {
  it("reach the owner's metric and refuse once the grant ends", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedCustomMetric(owner.id, "owner-water");
    await seedCustomMetric(delegate.id, "delegate-water");
    const ownerMetric = await getPrismaClient().customMetric.findFirstOrThrow({
      where: { userId: owner.id },
    });
    const delegateMetric =
      await getPrismaClient().customMetric.findFirstOrThrow({
        where: { userId: delegate.id },
      });

    const detail = await import("@/app/api/custom-metrics/[id]/route");
    const entries = await import("@/app/api/custom-metrics/[id]/entries/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const mine = await call(
      detail.GET as Handler,
      `/api/custom-metrics/${ownerMetric.id}`,
      { id: ownerMetric.id },
    );
    expect(mine.status).toBe(200);
    expect((await body(mine)).data).toMatchObject({ name: "owner-water" });

    // The entries route establishes ownership on the METRIC first and only
    // then queries by `customMetricId`. That hop now resolves against the
    // owner, so the delegate's own metric is unreachable from in here.
    const theirEntries = await call(
      entries.GET as Handler,
      `/api/custom-metrics/${delegateMetric.id}/entries`,
      { id: delegateMetric.id },
    );
    expect(theirEntries.status).toBe(404);

    const ownerEntries = await call(
      entries.GET as Handler,
      `/api/custom-metrics/${ownerMetric.id}/entries`,
      { id: ownerMetric.id },
    );
    expect(ownerEntries.status).toBe(200);
    const payload = (await body(ownerEntries)).data as {
      entries: { value: number }[];
    };
    expect(payload.entries.map((e) => e.value)).toEqual([250]);

    await revokeGrant(grant.id);
    await expectDenied(
      await call(
        entries.GET as Handler,
        `/api/custom-metrics/${ownerMetric.id}/entries`,
        { id: ownerMetric.id },
      ),
    );
  });

  it("are unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedCustomMetric(plain.id, "plain-water");
    const metric = await getPrismaClient().customMetric.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/custom-metrics/[id]/route");
    const response = await call(
      GET as Handler,
      `/api/custom-metrics/${metric.id}`,
      { id: metric.id },
    );
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({ name: "plain-water" });
  });
});

async function seedPersonalRecord(userId: string, value: number) {
  await getPrismaClient().personalRecord.create({
    data: {
      userId,
      metricType: "WEIGHT",
      direction: "MIN",
      value,
      unit: "kg",
      achievedAt: new Date("2026-06-01T08:00:00Z"),
    },
  });
}

contract<number>("GET /api/personal-records", {
  call: async () => {
    const { GET } = await import("@/app/api/personal-records/route");
    return call(GET as Handler, "/api/personal-records");
  },
  seed: seedPersonalRecord,
  read: (payload: { value: number }[]) => payload.map((r) => r.value),
  ownerMarker: 79.5,
  delegateMarker: 61.5,
});

/* -------------------------------------------------------------------------- */
/* Sleep, nutrients, illness, workouts                                        */
/* -------------------------------------------------------------------------- */

async function seedSleepStage(userId: string, minutes: number) {
  await getPrismaClient().measurement.create({
    data: {
      userId,
      type: "SLEEP_DURATION",
      value: minutes,
      unit: "min",
      measuredAt: new Date(Date.now() - 8 * 3_600_000),
      source: "MANUAL",
      sleepStage: "DEEP",
    },
  });
}

describe("GET /api/sleep/night", () => {
  it("reads the owner's night and refuses once the grant ends", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedSleepStage(owner.id, 90);
    await seedSleepStage(delegate.id, 30);

    const { GET } = await import("@/app/api/sleep/night/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const response = await call(GET as Handler, "/api/sleep/night");
    expect(response.status).toBe(200);
    const payload = (await body(response)).data as {
      main: { stages?: unknown; totalMinutes?: number } | null;
    };
    // The owner's 90 minutes, not the delegate's 30.
    expect(JSON.stringify(payload)).toContain("90");
    expect(JSON.stringify(payload)).not.toContain('"30"');

    await revokeGrant(grant.id);
    await expectDenied(await call(GET as Handler, "/api/sleep/night"));
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedSleepStage(plain.id, 90);
    await signIn(plain.id);

    const { GET } = await import("@/app/api/sleep/night/route");
    const response = await call(GET as Handler, "/api/sleep/night");
    expect(response.status).toBe(200);
    expect(JSON.stringify((await body(response)).data)).toContain("90");
  });

  it("refuses a caller who names a record they were never granted", async () => {
    const owner = await makeUser("owner");
    const stranger = await makeUser("stranger");
    const session = await signIn(stranger.id);
    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: owner.id },
    });

    const { GET } = await import("@/app/api/sleep/night/route");
    await expectDenied(await call(GET as Handler, "/api/sleep/night"));
  });
});

describe("GET /api/sleep/rhythm", () => {
  it("follows the record's sleep module, not the delegate's", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await getPrismaClient().user.update({
      where: { id: owner.id },
      data: { modulePreferencesJson: { sleep: false } },
    });
    await getPrismaClient().user.update({
      where: { id: delegate.id },
      data: { modulePreferencesJson: { sleep: true } },
    });

    await switchInto(owner.id, delegate.id);
    const { GET } = await import("@/app/api/sleep/rhythm/route");
    const response = await call(GET as Handler, "/api/sleep/rhythm");

    expect(response.status).toBe(403);
    expect((await body(response)).meta?.errorCode).toBe("module.disabled");
  });

  it("is unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await signIn(plain.id);
    const { GET } = await import("@/app/api/sleep/rhythm/route");
    expect((await call(GET as Handler, "/api/sleep/rhythm")).status).toBe(200);
  });
});

async function seedNutrient(userId: string, amount: number) {
  // Opt-in module, default off. Enabled on whoever is seeded, so the delegate
  // case below exercises the substitution rather than the gate.
  await getPrismaClient().user.update({
    where: { id: userId },
    data: { modulePreferencesJson: { nutrients: true } },
  });
  const day = new Date().toISOString().slice(0, 10);
  await getPrismaClient().nutrientIntakeDay.create({
    data: { userId, day, nutrient: "magnesium", amount, unit: "mg" },
  });
}

contract<number>("GET /api/nutrients", {
  call: async () => {
    const { GET } = await import("@/app/api/nutrients/route");
    return call(GET as Handler, "/api/nutrients?days=30");
  },
  seed: seedNutrient,
  read: (payload: { nutrients: { latestAmount: number }[] }) =>
    payload.nutrients.map((n) => n.latestAmount),
  ownerMarker: 320,
  delegateMarker: 145,
});

contract<number>("GET /api/nutrients/daily", {
  call: async () => {
    const { GET } = await import("@/app/api/nutrients/daily/route");
    return call(GET as Handler, "/api/nutrients/daily?nutrient=magnesium");
  },
  seed: seedNutrient,
  read: (payload: { days: { amount: number }[] }) =>
    payload.days.map((d) => d.amount).filter((a) => a > 0),
  ownerMarker: 320,
  delegateMarker: 145,
});

async function seedEpisode(userId: string, label: string) {
  const episode = await getPrismaClient().illnessEpisode.create({
    data: {
      userId,
      label,
      type: "INFECTION",
      onsetAt: new Date("2026-07-01T00:00:00Z"),
    },
  });
  await getPrismaClient().illnessDayLog.create({
    data: {
      userId,
      episodeId: episode.id,
      date: "2026-07-02",
      functionalImpact: 3,
    },
  });
}

contract<string>("GET /api/illness/episodes", {
  call: async () => {
    const { GET } = await import("@/app/api/illness/episodes/route");
    return call(GET as Handler, "/api/illness/episodes");
  },
  seed: seedEpisode,
  read: (payload: { label: string }[]) => payload.map((e) => e.label),
  ownerMarker: "owner-flu",
  delegateMarker: "delegate-flu",
});

describe("GET /api/illness/episodes/[id] and its day logs", () => {
  it("resolve the ownership hop against the record", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedEpisode(owner.id, "owner-flu");
    await seedEpisode(delegate.id, "delegate-flu");
    const ownerEpisode =
      await getPrismaClient().illnessEpisode.findFirstOrThrow({
        where: { userId: owner.id },
      });
    const delegateEpisode =
      await getPrismaClient().illnessEpisode.findFirstOrThrow({
        where: { userId: delegate.id },
      });

    const detail = await import("@/app/api/illness/episodes/[id]/route");
    const logs = await import("@/app/api/illness/episodes/[id]/day-logs/route");
    const { grant } = await switchInto(owner.id, delegate.id);

    const mine = await call(
      detail.GET as Handler,
      `/api/illness/episodes/${ownerEpisode.id}`,
      { id: ownerEpisode.id },
    );
    expect(mine.status).toBe(200);
    expect((await body(mine)).data).toMatchObject({ label: "owner-flu" });

    // `loadOwnedEpisode` is what makes the episode-scoped day-log query safe.
    // It now resolves against the owner, so the delegate's own episode 404s
    // from in here rather than leaking its logs.
    const theirs = await call(
      logs.GET as Handler,
      `/api/illness/episodes/${delegateEpisode.id}/day-logs?date=2026-07-02`,
      { id: delegateEpisode.id },
    );
    expect(theirs.status).toBe(404);

    const ownerLog = await call(
      logs.GET as Handler,
      `/api/illness/episodes/${ownerEpisode.id}/day-logs?date=2026-07-02`,
      { id: ownerEpisode.id },
    );
    expect(ownerLog.status).toBe(200);
    expect((await body(ownerLog)).data).toMatchObject({
      functionalImpact: 3,
    });

    await revokeGrant(grant.id);
    await expectDenied(
      await call(
        detail.GET as Handler,
        `/api/illness/episodes/${ownerEpisode.id}`,
        { id: ownerEpisode.id },
      ),
    );
  });

  it("are unchanged for a caller who has not switched", async () => {
    const plain = await makeUser("plain");
    await seedEpisode(plain.id, "plain-flu");
    const episode = await getPrismaClient().illnessEpisode.findFirstOrThrow({
      where: { userId: plain.id },
    });
    await signIn(plain.id);

    const { GET } = await import("@/app/api/illness/episodes/[id]/route");
    const response = await call(
      GET as Handler,
      `/api/illness/episodes/${episode.id}`,
      { id: episode.id },
    );
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({ label: "plain-flu" });
  });
});

async function seedWorkout(userId: string, durationSec: number) {
  await getPrismaClient().workout.create({
    data: {
      userId,
      sportType: "RUNNING",
      startedAt: new Date("2026-07-11T06:00:00Z"),
      endedAt: new Date("2026-07-11T07:00:00Z"),
      durationSec,
    },
  });
}

contract<number>("GET /api/workouts", {
  call: async () => {
    const { GET } = await import("@/app/api/workouts/route");
    return call(GET as Handler, "/api/workouts");
  },
  seed: seedWorkout,
  read: (payload: { workouts: { durationSec: number | null }[] }) =>
    payload.workouts
      .map((w) => w.durationSec)
      .filter((d): d is number => d !== null),
  ownerMarker: 3600,
  delegateMarker: 1800,
});
