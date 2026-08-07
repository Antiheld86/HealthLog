/**
 * Integration guard for `DELETE /api/settings/data` — "Delete All Data".
 *
 * The whole defect is about rows that survive, so a mocked Prisma proves
 * nothing: it can only show that the calls the route makes were made. This
 * runs against real Postgres, seeds a row into every table in the schema, runs
 * the wipe, and then asks the database what is left.
 *
 * The seeding is driven by `information_schema` and `pg_constraint` rather
 * than a hand-written fixture, for the same reason the wipe list is derived
 * rather than hand-written: a fixture written today covers the schema of
 * today. A table added next year is seeded automatically and therefore
 * asserted automatically.
 *
 * What it asserts:
 *   - every model in `WIPE_MODELS` has zero rows for the account afterwards;
 *   - every model in `WIPE_EXEMPT` still has its row, so the "kept" half of
 *     the confirmation copy is true too;
 *   - every table the wipe reaches only through a database cascade is empty;
 *   - the instance-scoped tables are untouched;
 *   - the `User` row survives with `USER_RESET` applied and
 *     `USER_KEPT_FIELDS` intact.
 *
 * Its honest limit: it proves the wipe removes what the plan declares. The
 * plan being right is what `src/__tests__/data-wipe-completeness.test.ts`
 * holds against `schema.prisma`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import {
  INSTANCE_SCOPED,
  USER_KEPT_FIELDS,
  USER_RESET,
  WIPE_EXEMPT,
  WIPE_MODELS,
  WIPE_OWNER_FIELDS,
} from "@/lib/data-wipe/wipe-plan";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  claimManagedGuardianEgressAuthorization,
  resolveNotificationDeliveryIdentity,
} from "@/lib/notifications/delivery-identity";

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

// ── schema.prisma model → table name ────────────────────────────────────────

function modelTableMap(): Map<string, string> {
  const schema = readFileSync(
    join(process.cwd(), "prisma", "schema.prisma"),
    "utf8",
  );
  const map = new Map<string, string>();
  for (const block of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const mapped = /@@map\("([^"]+)"\)/.exec(block[2]);
    map.set(block[1], mapped ? mapped[1] : block[1]);
  }
  return map;
}

// ── generic seeder ──────────────────────────────────────────────────────────

interface ColumnRow {
  table_name: string;
  column_name: string;
  is_nullable: string;
  column_default: string | null;
  udt_name: string;
}

interface ForeignKeyRow {
  table_name: string;
  column_name: string;
  ref_table: string;
  ref_column: string;
  cascades: boolean;
}

/** Tables the seeder never writes: Prisma's own ledger, and the account row. */
const SEED_SKIP = new Set(["_prisma_migrations", "users"]);

function synthesise(udt: string, enums: Map<string, string>, tag: string) {
  if (udt.startsWith("_")) return `'{}'::${udt.slice(1)}[]`;
  switch (udt) {
    case "text":
    case "varchar":
    case "bpchar":
      return `'${tag}'`;
    case "int2":
    case "int4":
    case "int8":
    case "numeric":
    case "float4":
    case "float8":
      return "1";
    case "bool":
      return "false";
    case "timestamp":
    case "timestamptz":
    case "date":
      return "now()";
    case "bytea":
      return "'\\x00'::bytea";
    case "json":
    case "jsonb":
      return `'{}'::${udt}`;
    case "uuid":
      return "gen_random_uuid()";
    default: {
      const label = enums.get(udt);
      if (label) return `'${label}'::"${udt}"`;
      throw new Error(`seeder has no value for column type "${udt}"`);
    }
  }
}

/**
 * Insert one row into every table in `public`, parents first, wiring every
 * foreign key to the row already created for its target and every `user_id` to
 * the account under test.
 */
async function seedEveryTable(
  prisma: PrismaClient,
  userId: string,
): Promise<string[]> {
  const columns = await prisma.$queryRaw<ColumnRow[]>`
    SELECT table_name, column_name, is_nullable, column_default, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'`;

  const foreignKeys = await prisma.$queryRaw<ForeignKeyRow[]>`
    SELECT con.conrelid::regclass::text  AS table_name,
           att.attname                   AS column_name,
           con.confrelid::regclass::text AS ref_table,
           ratt.attname                  AS ref_column,
           con.confdeltype = 'c'         AS cascades
    FROM pg_constraint con
    JOIN LATERAL unnest(con.conkey)  WITH ORDINALITY AS ck(attnum, ord) ON true
    JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS rk(attnum, ord)
      ON rk.ord = ck.ord
    JOIN pg_attribute att  ON att.attrelid  = con.conrelid  AND att.attnum = ck.attnum
    JOIN pg_attribute ratt ON ratt.attrelid = con.confrelid AND ratt.attnum = rk.attnum
    WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace`;

  const enumRows = await prisma.$queryRaw<
    Array<{ typname: string; enumlabel: string }>
  >`
    SELECT t.typname, e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    ORDER BY t.typname, e.enumsortorder`;
  const enums = new Map<string, string>();
  for (const row of enumRows) {
    if (!enums.has(row.typname)) enums.set(row.typname, row.enumlabel);
  }

  const byTable = new Map<string, ColumnRow[]>();
  for (const column of columns) {
    if (SEED_SKIP.has(column.table_name)) continue;
    const bucket = byTable.get(column.table_name) ?? [];
    bucket.push(column);
    byTable.set(column.table_name, bucket);
  }

  const fkByTable = new Map<string, ForeignKeyRow[]>();
  for (const fk of foreignKeys) {
    const bucket = fkByTable.get(fk.table_name) ?? [];
    bucket.push(fk);
    fkByTable.set(fk.table_name, bucket);
  }

  // Parents before children. A self-reference or an optional cycle is skipped
  // by only ordering on the columns the insert actually fills.
  const pending = new Set(byTable.keys());
  const ordered: string[] = [];
  while (pending.size > 0) {
    let progressed = false;
    for (const table of [...pending]) {
      const blocked = (fkByTable.get(table) ?? []).some(
        (fk) => fk.ref_table !== table && pending.has(fk.ref_table),
      );
      if (blocked) continue;
      ordered.push(table);
      pending.delete(table);
      progressed = true;
    }
    if (!progressed) {
      throw new Error(
        `foreign-key cycle among: ${[...pending].sort().join(", ")}`,
      );
    }
  }

  const insertedId = new Map<string, string>();
  let tag = 0;

  for (const table of ordered) {
    const tableColumns = byTable.get(table)!;
    const fks = fkByTable.get(table) ?? [];
    const names: string[] = [];
    const values: string[] = [];

    for (const column of tableColumns) {
      const fk = fks.find((f) => f.column_name === column.column_name);
      const required =
        column.is_nullable === "NO" && column.column_default === null;
      const isUserColumn = column.column_name === "user_id";

      if (fk?.ref_table === "users") {
        // Always bind to the account under test, nullable or not — a NULL
        // owner would put the row outside the wipe and make the assertion
        // vacuous.
        names.push(column.column_name);
        values.push(`'${userId}'`);
        continue;
      }
      if (!required && !isUserColumn) continue;
      if (fk) {
        const parent = insertedId.get(fk.ref_table);
        if (!parent) {
          throw new Error(
            `${table}.${column.column_name} references ${fk.ref_table}, which was not seeded`,
          );
        }
        names.push(column.column_name);
        values.push(`'${parent}'`);
        continue;
      }
      names.push(column.column_name);
      values.push(synthesise(column.udt_name, enums, `seed-${tag++}`));
    }

    const sql =
      names.length === 0
        ? `INSERT INTO "${table}" DEFAULT VALUES ON CONFLICT DO NOTHING`
        : `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${values.join(", ")}) ON CONFLICT DO NOTHING`;
    await prisma.$executeRawUnsafe(sql);

    const hasId = tableColumns.some((c) => c.column_name === "id");
    if (hasId) {
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "${table}" LIMIT 1`,
      );
      if (rows[0]) insertedId.set(table, rows[0].id);
    }
  }

  return ordered;
}

/**
 * The columns that bind a row of `model` to an account, as SQL identifiers.
 *
 * `user_id` is the convention. A model that relates two accounts cannot use
 * it, and the wipe plan already declares its columns — read them from there
 * rather than keeping a second list here, or the two would answer differently
 * and this file would be asserting against its own idea of ownership instead
 * of the one the route uses.
 */
function ownerColumns(model: string | undefined): string[] {
  const declared = model ? WIPE_OWNER_FIELDS[model] : undefined;
  if (!declared) return ["user_id"];
  return declared.map((field) =>
    field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
  );
}

async function countRows(
  prisma: PrismaClient,
  table: string,
  userId?: string,
  model?: string,
): Promise<number> {
  const predicate = ownerColumns(model)
    .map((column) => `"${column}" = $1`)
    .join(" OR ");
  const rows = userId
    ? await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM "${table}" WHERE ${predicate}`,
        userId,
      )
    : await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM "${table}"`,
      );
  return Number(rows[0].n);
}

async function managedProfileLockIsHeld(
  prisma: PrismaClient,
  profileId: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ locked: boolean }>>`
    SELECT NOT pg_try_advisory_xact_lock(
      hashtextextended(${`managed-profile:${profileId}`}, 0)
    ) AS locked
  `;
  return rows[0]?.locked === true;
}

describe("DELETE /api/settings/data leaves nothing it promised to delete", () => {
  beforeEach(async () => {
    await truncateAllTables(getPrismaClient());
    cookieJar.clear();
    headerJar.clear();
  });

  it("wipes every in-scope table and keeps exactly the declared set", async () => {
    const prisma = getPrismaClient();
    const tables = modelTableMap();

    const user = await prisma.user.create({
      data: {
        username: "wipe-subject",
        email: "wipe-subject@example.test",
        heightCm: 180,
        dateOfBirth: new Date("1990-01-01T00:00:00Z"),
        gender: "OTHER",
        fullName: "Seeded Name",
        insurerName: "Seeded Insurer",
        stravaAthleteId: "12345",
        thresholdsJson: { sys: 130 },
        onboardingCompletedAt: new Date(),
        onboardingStep: 4,
        passwordHash: "argon2-placeholder",
        locale: "en",
        unitPreference: "metric",
      },
    });

    const seeded = await seedEveryTable(prisma, user.id);
    expect(
      seeded.length,
      "the seeder should reach essentially the whole schema",
    ).toBeGreaterThan(100);

    // The session has to be created after the generic seed so its id is the
    // one the cookie carries. `mfaVerifiedAt` is set because the seeder also
    // planted a WebAuthn MFA credential, which makes the account MFA-enrolled
    // and puts the route behind a fresh step-up.
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
        mfaVerifiedAt: new Date(),
      },
    });
    cookieJar.set("healthlog_session", session.id);

    // ── act ──
    const { DELETE } = await import("@/app/api/settings/data/route");
    const response = await DELETE(
      new Request("http://localhost/api/settings/data", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "DELETE" }),
      }) as never,
    );
    expect(response.status).toBe(200);

    // ── assert: nothing the plan claims to delete is left ──
    const survivors: string[] = [];
    for (const model of WIPE_MODELS) {
      const table = tables.get(model)!;
      // `AuditLog` is wiped inside the transaction and then receives exactly
      // one new row after it commits: the receipt for the wipe itself. The
      // history is gone; the record that the person asked for it is not.
      const expected = model === "AuditLog" ? 1 : 0;
      if ((await countRows(prisma, table, user.id, model)) > expected) {
        survivors.push(`${model} (${table})`);
      }
    }
    expect(
      survivors,
      `rows survived a wipe that told the person everything was deleted:\n${survivors.join("\n")}`,
    ).toEqual([]);

    // The one surviving audit row is the receipt, not leftover history.
    const auditRows = await prisma.auditLog.findMany({
      where: { userId: user.id },
      select: { action: true },
    });
    expect(auditRows.map((r) => r.action)).toEqual(["user.data.clear"]);

    // ── assert: the kept set is exactly what the copy promises ──
    const missing: string[] = [];
    for (const model of Object.keys(WIPE_EXEMPT)) {
      const table = tables.get(model)!;
      if ((await countRows(prisma, table, user.id)) === 0) {
        missing.push(`${model} (${table})`);
      }
    }
    expect(
      missing,
      `the copy says these are kept, and they are gone:\n${missing.join("\n")}`,
    ).toEqual([]);

    // ── assert: the instance's own tables are untouched ──
    for (const model of Object.keys(INSTANCE_SCOPED)) {
      if (model === "User") continue;
      const table = tables.get(model)!;
      expect(
        await countRows(prisma, table),
        `${model} belongs to the instance and must survive one account's wipe`,
      ).toBeGreaterThan(0);
    }

    // ── assert: everything reached only by cascade is gone too ──
    const wipedTables = new Set(WIPE_MODELS.map((m) => tables.get(m)!));
    const exemptTables = new Set(
      Object.keys(WIPE_EXEMPT).map((m) => tables.get(m)!),
    );
    const instanceTables = new Set(
      Object.keys(INSTANCE_SCOPED).map((m) => tables.get(m)!),
    );
    const leftovers: string[] = [];
    for (const table of seeded) {
      if (wipedTables.has(table)) continue;
      if (exemptTables.has(table)) continue;
      if (instanceTables.has(table)) continue;
      if ((await countRows(prisma, table)) > 0) leftovers.push(table);
    }
    expect(
      leftovers,
      `tables the wipe reaches only through a database cascade still hold rows:\n${leftovers.join("\n")}`,
    ).toEqual([]);

    // ── assert: the account survives, reset but signed-in-able ──
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const record = after as unknown as Record<string, unknown>;

    expect(record.username).toBe("wipe-subject");
    expect(record.passwordHash).toBe("argon2-placeholder");
    for (const column of Object.keys(USER_KEPT_FIELDS)) {
      expect(record).toHaveProperty(column);
    }
    expect(record.locale).toBe("en");
    expect(record.unitPreference).toBe("metric");

    const stillSet: string[] = [];
    for (const column of Object.keys(USER_RESET)) {
      const value = record[column];
      const cleared =
        value === null ||
        value === false ||
        value === 0 ||
        (Array.isArray(value) && value.length === 0) ||
        value === "aggregated" ||
        value === "disconnected";
      if (!cleared) stillSet.push(`${column} = ${JSON.stringify(value)}`);
    }
    expect(
      stillSet,
      `User columns the plan resets still carry a value:\n${stillSet.join("\n")}`,
    ).toEqual([]);
  });

  it("refuses a wipe that would remove a managed profile's last Guardian", async () => {
    const prisma = getPrismaClient();
    const [guardian, profile] = await Promise.all([
      prisma.user.create({
        data: {
          username: "wipe-last-guardian",
          email: "wipe-last-guardian@example.test",
        },
      }),
      prisma.user.create({
        data: {
          username: "wipe-last-profile",
          email: "wipe-last-profile@example.test",
          managedProfileAt: new Date(),
        },
      }),
    ]);
    await prisma.accountGrant.create({
      data: {
        grantorId: profile.id,
        granteeId: guardian.id,
        access: "MANAGE",
        acceptedAt: new Date(),
      },
    });
    await prisma.measurement.create({
      data: {
        userId: guardian.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date(),
      },
    });
    const session = await prisma.session.create({
      data: { userId: guardian.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    const { DELETE } = await import("@/app/api/settings/data/route");
    const response = await DELETE(
      new Request("http://localhost/api/settings/data", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "DELETE" }),
      }) as never,
    );

    expect(response.status).toBe(409);
    expect(
      await prisma.accountGrant.count({
        where: { grantorId: profile.id, granteeId: guardian.id },
      }),
    ).toBe(1);
    expect(
      await prisma.measurement.count({ where: { userId: guardian.id } }),
    ).toBe(1);
  });

  it("makes a queued Guardian claim observe a completed data wipe", async () => {
    const prisma = getPrismaClient();
    const [guardian, reserveGuardian, profile] = await Promise.all([
      prisma.user.create({
        data: {
          username: "wipe-race-guardian",
          email: "wipe-race-guardian@example.test",
        },
      }),
      prisma.user.create({
        data: {
          username: "wipe-race-reserve",
          email: "wipe-race-reserve@example.test",
        },
      }),
      prisma.user.create({
        data: {
          username: "wipe-race-profile",
          email: "wipe-race-profile@example.test",
          managedProfileAt: new Date(),
        },
      }),
    ]);
    await Promise.all([
      prisma.accountGrant.create({
        data: {
          grantorId: profile.id,
          granteeId: guardian.id,
          access: "MANAGE",
          acceptedAt: new Date(),
        },
      }),
      prisma.accountGrant.create({
        data: {
          grantorId: profile.id,
          granteeId: reserveGuardian.id,
          access: "MANAGE",
          acceptedAt: new Date(),
        },
      }),
    ]);
    expect(
      await prisma.accountGrant.count({
        where: {
          grantorId: profile.id,
          access: "MANAGE",
          acceptedAt: { not: null },
          revokedAt: null,
        },
      }),
    ).toBe(2);
    const measurement = await prisma.measurement.create({
      data: {
        userId: guardian.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date(),
      },
    });
    const session = await prisma.session.create({
      data: { userId: guardian.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);
    const delivery = await resolveNotificationDeliveryIdentity({
      eventType: "MEDICATION_REMINDER",
      userId: profile.id,
      recordUserId: profile.id,
      recipientUserId: guardian.id,
      title: "record reminder",
      message: "record message",
    });
    expect(delivery).toMatchObject({ managed: true });

    let releaseMeasurement!: () => void;
    let markMeasurementLocked!: () => void;
    const measurementLocked = new Promise<void>((resolve) => {
      markMeasurementLocked = resolve;
    });
    const holdMeasurement = new Promise<void>((resolve) => {
      releaseMeasurement = resolve;
    });
    const blocker = prisma.$transaction(async (tx) => {
      await tx.measurement.update({
        where: { id: measurement.id },
        data: { value: 81 },
      });
      markMeasurementLocked();
      await holdMeasurement;
    });
    await measurementLocked;

    const { DELETE } = await import("@/app/api/settings/data/route");
    const wipe = DELETE(
      new Request("http://localhost/api/settings/data", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "DELETE" }),
      }) as never,
    );
    await vi.waitFor(async () => {
      expect(await managedProfileLockIsHeld(prisma, profile.id)).toBe(true);
    });

    const claim = claimManagedGuardianEgressAuthorization(
      delivery!,
      "NTFY",
      "MEDICATION_REMINDER",
    );
    await expectPromiseToRemainPending(claim);

    releaseMeasurement();
    await blocker;
    expect((await wipe).status).toBe(200);
    await expect(claim).resolves.toBeNull();
    expect(await prisma.notificationEgressAuthorization.count()).toBe(0);
    expect(await prisma.pushAttempt.count()).toBe(0);
  });

  it("refuses without the typed confirmation and leaves the record alone", async () => {
    const prisma = getPrismaClient();

    const user = await prisma.user.create({
      data: { username: "wipe-refused", email: "wipe-refused@example.test" },
    });
    const session = await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date(),
      },
    });

    const { DELETE } = await import("@/app/api/settings/data/route");
    const response = await DELETE(
      new Request("http://localhost/api/settings/data", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "nope" }),
      }) as never,
    );

    expect(response.status).toBe(422);
    expect(await prisma.measurement.count({ where: { userId: user.id } })).toBe(
      1,
    );
  });

  it("revokes a clinician share link so the token resolves to nothing", async () => {
    const prisma = getPrismaClient();

    const user = await prisma.user.create({
      data: { username: "wipe-sharer", email: "wipe-sharer@example.test" },
    });
    const session = await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    const { hashToken } = await import("@/lib/auth/hmac");
    const rawToken = `hls_${"a".repeat(48)}`;
    await prisma.clinicianShareLink.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        label: "Practice",
        rangeStart: new Date("2026-01-01T00:00:00Z"),
        sectionsJson: {},
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const { resolveShareToken } =
      await import("@/lib/clinician-share/resolve-share-token");
    expect(await resolveShareToken(rawToken)).not.toBeNull();

    const { DELETE } = await import("@/app/api/settings/data/route");
    const response = await DELETE(
      new Request("http://localhost/api/settings/data", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "DELETE" }),
      }) as never,
    );
    expect(response.status).toBe(200);

    // A clinician holding the link now reads nothing, not a stale record.
    expect(await resolveShareToken(rawToken)).toBeNull();
  });
});

async function expectPromiseToRemainPending(promise: Promise<unknown>) {
  const settled = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
  expect(settled).toBe(false);
}
