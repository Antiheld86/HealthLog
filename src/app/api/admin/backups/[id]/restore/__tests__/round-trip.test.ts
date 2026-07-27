/**
 * Export → wire schema → restore, driven end to end.
 *
 * Every other test around the backup proves ONE end. `full-backup-payload.test.ts`
 * proves the builder emits a key; the restore tests prove the route refuses a
 * bad file. Between them sits the gap that lost three domains in a row: a key
 * the builder emits, the schema drops or nobody reads, and the restore reports
 * success over.
 *
 * So this test does not assert on the payload. It builds a real payload from a
 * populated account, serialises it, parses it back through the REAL
 * `parseBackupPayload`, hands it to the REAL route, and asserts on the rows the
 * restore tried to write. A field that survives that survives a restore.
 *
 * The transaction stand-in is deliberately not inert: `cycleSymptom.findMany`
 * answers from what the restore actually upserted. If the account's own symptom
 * definitions do not ride the file, the link resolution finds nothing and the
 * restore throws — which is what a real instance does, and is exactly how the
 * inert v1.33.1 fix behaved in production.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (fn: unknown) => fn,
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  requireAdmin: vi.fn(async () => ({ user: { id: "admin-1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    dataBackup: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: mocks.transaction,
  },
}));

// Only `decrypt` is stubbed — it stands in for reading the stored backup blob.
// The rest of the module stays real, so the ciphertext this test builds and the
// ciphertext the restore writes are produced by the same code an instance runs.
vi.mock("@/lib/crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/crypto")>()),
  decrypt: mocks.decrypt,
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency: (fn: unknown) => fn,
  defaultUserIdResolver: vi.fn(),
}));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateUserData: vi.fn() }));
vi.mock("@/lib/rollups/mood-rollups", () => ({
  recomputeUserMoodRollups: vi.fn(),
}));
vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  recomputeUserMedicationCompliance: vi.fn(),
  MEDICATION_COMPLIANCE_BACKFILL_DAYS: 30,
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeUserRollups: vi.fn(),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";

const OWNER = "user-A";

/**
 * A day's cumulative curve, twenty-four running totals. Uneven on purpose: a
 * flat ramp would survive a restore that rebuilt the shape from `dayTotal`
 * instead of carrying it, and this file is the only copy of the real one.
 */
const DAY_CURVE = [
  0, 0, 0, 0, 0, 0, 120, 940, 2310, 2380, 2400, 2860, 4120, 4180, 4200, 4260,
  5010, 6340, 7480, 8020, 8090, 8110, 8110, 8110,
];

/* ── the account being backed up ────────────────────────────────────── */

function sourceClient() {
  const empty = { findMany: vi.fn().mockResolvedValue([]) };
  return {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    measurement: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    medication: { findMany: vi.fn().mockResolvedValue([]) },
    medicationIntakeEvent: empty,
    moodEntry: empty,
    moodTag: empty,
    nutrientIntakeDay: empty,
    // Cycle: one day-log whose symptom is one the ACCOUNT defined, which is
    // the case the payload assembly used to drop.
    cycleProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    menstrualCycle: { findMany: vi.fn().mockResolvedValue([]) },
    cycleDayLog: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "day-1",
          date: "2026-07-19",
          cycleId: null,
          flow: null,
          intermenstrualBleeding: false,
          basalBodyTempC: null,
          temperatureExcluded: false,
          ovulationTest: null,
          cervicalMucus: null,
          cervixPosition: null,
          cervixFirmness: null,
          cervixOpening: null,
          sexualActivity: false,
          protectedSex: null,
          pregnancyTest: null,
          progesteroneTest: null,
          contraceptive: null,
          sensitiveEncrypted: null,
          notesEncrypted: null,
          source: "MANUAL",
          externalId: null,
          tz: null,
          syncVersion: 0,
          deletedAt: null,
          createdAt: new Date("2026-07-19T00:00:00.000Z"),
          updatedAt: new Date("2026-07-19T00:00:00.000Z"),
          symptomLinks: [{ symptom: { key: "custom:jaw_tension" } }],
        },
      ]),
    },
    cycleSymptom: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "sym-1",
          key: "custom:jaw_tension",
          labelKey: "custom",
          categoryId: "cat-1",
          icon: null,
          sortOrder: 0,
          isActive: true,
          labelEncrypted: "envelope",
        },
      ]),
    },
    // Records section: empty, exercised by its own suite.
    labResult: empty,
    biomarker: empty,
    illnessEpisode: empty,
    allergy: empty,
    familyHistoryEntry: empty,
    workout: empty,
    inboundDocument: empty,
    // The two domains this stream adds.
    userHealthProfile: {
      findUnique: vi.fn().mockResolvedValue({
        id: "profile-1",
        userId: OWNER,
        aboutMeEncrypted: encryptToBytes("desk job, two kids"),
        conditionsEncrypted: null,
        allergiesEncrypted: encryptToBytes("penicillin"),
        coachFocusEncrypted: null,
        pendingQuestionsEncrypted: encryptToBytes('["How is your sleep?"]'),
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-19T00:00:00.000Z"),
      }),
    },
    // The hourly shape of a drained day. The per-sample rows it was folded
    // from are already gone, so nothing but this row can rebuild it.
    intradayCumulativeProfile: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "shape-1",
          userId: OWNER,
          type: "ACTIVITY_STEPS",
          dateKey: "2026-07-18",
          hourlyCumulative: DAY_CURVE,
          dayTotal: DAY_CURVE[23],
          sampleCount: 96,
          timezone: "Europe/Berlin",
          createdAt: new Date("2026-07-19T02:00:00.000Z"),
          updatedAt: new Date("2026-07-19T02:00:00.000Z"),
        },
      ]),
    },
    customMetric: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "metric-1",
          userId: OWNER,
          name: "Morning grip strength",
          unit: "kg",
          targetLow: 40,
          targetHigh: null,
          decimals: 1,
          description: "Right hand, before breakfast",
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          updatedAt: new Date("2026-07-19T00:00:00.000Z"),
          deletedAt: null,
          entries: [
            {
              id: "entry-1",
              value: 44.5,
              unit: "kg",
              measuredAt: new Date("2026-07-19T06:30:00.000Z"),
              note: "felt strong",
              createdAt: new Date("2026-07-19T06:31:00.000Z"),
            },
          ],
        },
      ]),
    },
  };
}

/* ── the instance being restored into ───────────────────────────────── */

interface Written {
  model: string;
  op: string;
  data: Record<string, unknown>;
}

function recordingTx(written: Written[]) {
  // Symptom definitions the restore has written back, so link resolution can
  // only succeed if the definitions actually rode the file.
  const restoredSymptoms = new Map<string, string>();

  const delegate = (model: string) =>
    new Proxy(
      {},
      {
        get(_t, op: string) {
          return async (args: Record<string, unknown> = {}) => {
            if (op === "deleteMany") return { count: 0 };
            if (op === "findMany") {
              if (model === "cycleSymptom") {
                return [...restoredSymptoms].map(([key, id]) => ({ id, key }));
              }
              return [];
            }
            if (op === "findFirst" || op === "findUnique") return null;
            const data = (args.data ?? args.create ?? {}) as Record<
              string,
              unknown
            >;
            if (op === "create" || op === "upsert" || op === "createMany") {
              if (model === "cycleSymptom" && typeof data.key === "string") {
                restoredSymptoms.set(data.key, (data.id as string) ?? "new-id");
              }
              written.push({ model, op, data });
            }
            return { id: (data.id as string) ?? `${model}-created` };
          };
        },
      },
    );

  return new Proxy({} as Record<string, unknown>, {
    get: (_t, model: string) => delegate(model),
  });
}

function request(): NextRequest {
  return new NextRequest("http://localhost/api/admin/backups/b-1/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "RESTORE" }),
  });
}

/** Build a real backup for the account above, then restore it. */
async function roundTrip(): Promise<{ res: Response; written: Written[] }> {
  const { payload } = await buildFullBackupPayload(
    sourceClient() as never,
    OWNER,
    { purpose: "disaster-recovery" },
  );

  // The file as it lands on disk: JSON, nothing else.
  mocks.decrypt.mockReturnValue(JSON.stringify(payload));

  const written: Written[] = [];
  mocks.transaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(recordingTx(written)),
  );

  const res = await (
    POST as unknown as (r: NextRequest, c: unknown) => Promise<Response>
  )(request(), { params: Promise.resolve({ id: "b-1" }) });

  return { res, written };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.dataBackup.findUnique).mockResolvedValue({
    id: "b-1",
    userId: OWNER,
    data: "cipher",
    user: { id: OWNER, username: "owner" },
  } as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: OWNER,
    username: "owner",
    timezone: "UTC",
  } as never);
});

describe("backup round trip — export, wire schema, restore", () => {
  it("completes without the restore reporting a failure", async () => {
    const { res } = await roundTrip();
    expect(res.status).toBe(200);
  });

  it("writes the durable self-context back with its ciphertext intact", async () => {
    const { written } = await roundTrip();

    const profile = written.find((w) => w.model === "userHealthProfile");
    expect(
      profile,
      "the profile reached the file and nothing wrote it back",
    ).toBeDefined();
    expect(profile!.data.userId).toBe(OWNER);
    // The envelope round-trips as bytes, not as a re-encryption of plaintext
    // the DR file never carried.
    expect(profile!.data.aboutMeEncrypted).toBeInstanceOf(Uint8Array);
    expect(profile!.data.conditionsEncrypted).toBeNull();
    expect(profile!.data.pendingQuestionsEncrypted).toBeInstanceOf(Uint8Array);
  });

  it("writes each custom metric back with its readings", async () => {
    const { written } = await roundTrip();

    const metric = written.find((w) => w.model === "customMetric");
    expect(
      metric,
      "the metric reached the file and nothing wrote it back",
    ).toBeDefined();
    expect(metric!.data).toMatchObject({
      userId: OWNER,
      name: "Morning grip strength",
      unit: "kg",
      targetLow: 40,
      decimals: 1,
      description: "Right hand, before breakfast",
    });

    // The readings are the half that would go missing quietly: a metric with
    // no entries renders as an empty chart rather than as an error.
    const entries = (
      metric!.data.entries as { create: Array<Record<string, unknown>> }
    ).create;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      value: 44.5,
      unit: "kg",
      note: "felt strong",
    });
  });

  it("writes the day's cumulative shape back, every hour of it", async () => {
    const { written } = await roundTrip();

    const write = written.find(
      (w) => w.model === "intradayCumulativeProfile" && w.op === "createMany",
    );
    expect(
      write,
      "the day curve reached the file and nothing wrote it back",
    ).toBeDefined();

    const rows = write!.data as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "shape-1",
      userId: OWNER,
      type: "ACTIVITY_STEPS",
      dateKey: "2026-07-18",
      dayTotal: DAY_CURVE[23],
      sampleCount: 96,
      // Dropping the zone would make a curve cut on another clock look
      // comparable to one cut on this account's.
      timezone: "Europe/Berlin",
    });
    // The curve is the part that cannot be rebuilt from anything else, so it
    // is asserted hour by hour rather than by its total.
    expect(rows[0].hourlyCumulative).toEqual(DAY_CURVE);
  });

  it("writes the account's own cycle symptom back before resolving its links", async () => {
    const { written, res } = await roundTrip();

    // The definition has to land, or the link lookup below finds nothing.
    expect(
      written.find(
        (w) =>
          w.model === "cycleSymptom" && w.data.key === "custom:jaw_tension",
      ),
      "the custom symptom definition never reached the restore",
    ).toBeDefined();

    // And the day-log that references it restores rather than throwing on an
    // unresolvable key — the failure a real account hit while the fix was inert.
    expect(res.status).toBe(200);
    expect(written.find((w) => w.model === "cycleDayLog")).toBeDefined();
  });
});
