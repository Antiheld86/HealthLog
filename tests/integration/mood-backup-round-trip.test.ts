/**
 * A mood entry, out through the real backup and back in through the real
 * restore, asserted on the rows.
 *
 * Deliberately not a classification test. Asserting that the payload has a
 * `moodEntries` key proves nothing this repository has not already been burned
 * by: excise the restore call entirely and a shape check still reports green.
 * So this seeds an account, exports through `buildFullBackupPayload`, parses
 * through `parseBackupPayload`, restores through the real
 * `POST /api/admin/backups/[id]/restore`, and then reads the row back out of
 * Postgres and compares values.
 *
 * The fixture is the entry that used to come back wrong in four ways at once:
 * a ticked BINARY tag and a rated factor on the same entry, a note in the
 * encrypted column, a timezone that is not the legacy Europe/Berlin default,
 * and a sync counter above zero. The old payload carried none of them.
 *
 * The second case is the compatibility floor: a hand-written payload in the
 * shape files were written in BEFORE this change, restored through the same
 * route. Every field this adds is optional or defaulted precisely so that file
 * keeps working, and the only way to know is to send one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import type { PrismaClient } from "@/generated/prisma/client";
import { encrypt } from "@/lib/crypto";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { parseBackupPayload } from "@/lib/validations/backup";
import { POST } from "@/app/api/admin/backups/[id]/restore/route";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserData: vi.fn(),
}));

const OWNER_ID = "mood-round-trip-owner";
const NOTE = "slept badly, long walk in the afternoon";
const LOGGED_AT = new Date("2026-07-19T23:40:00.000Z");
const CREATED_AT = new Date("2026-07-19T23:41:00.000Z");
const UPDATED_AT = new Date("2026-07-20T06:05:00.000Z");
const DELETED_AT = new Date("2026-07-20T07:00:00.000Z");

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedAdminSession(prisma: PrismaClient) {
  const admin = await prisma.user.create({
    data: {
      username: "mood-round-trip-admin",
      email: "mood-round-trip-admin@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: { userId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return admin;
}

async function seedOwner(prisma: PrismaClient) {
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      username: "mood-round-trip-owner",
      email: "mood-round-trip-owner@example.test",
    },
  });
}

/**
 * The taxonomy the entry links to: one seeded BINARY tag (`userId: null`, the
 * reference data every instance has), one BINARY tag the account made itself,
 * and one RATED factor. The account's own tag matters — it travels in the file
 * as a `customMoodTags` row, and a restore that could not re-create it would
 * lose the link even with everything else correct.
 */
async function seedTaxonomy(prisma: PrismaClient) {
  const category = await prisma.moodTagCategory.create({
    data: {
      id: "mood-rt-category",
      key: "mood_round_trip",
      labelKey: "mood.tagCategory.roundTrip",
    },
  });
  const seededTag = await prisma.moodTag.create({
    data: {
      id: "mood-rt-seeded-tag",
      categoryId: category.id,
      key: "rt_headache",
      labelKey: "mood.tag.rtHeadache",
      kind: "BINARY",
    },
  });
  const ownTag = await prisma.moodTag.create({
    data: {
      id: "mood-rt-own-tag",
      userId: OWNER_ID,
      categoryId: category.id,
      key: "custom:rt_long_walk",
      labelKey: "mood.tag.custom",
      kind: "BINARY",
    },
  });
  const factor = await prisma.moodTag.create({
    data: {
      id: "mood-rt-factor",
      categoryId: category.id,
      key: "rt_sleep_quality",
      labelKey: "mood.tag.rtSleepQuality",
      kind: "RATED",
      scaleMin: 1,
      scaleMax: 5,
    },
  });
  return { category, seededTag, ownTag, factor };
}

function makeRestoreRequest(id: string) {
  return new Request(`http://localhost/api/admin/backups/${id}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "RESTORE" }),
  });
}

async function restoreFromPayload(
  prisma: PrismaClient,
  payload: unknown,
  type: string,
) {
  const backup = await prisma.dataBackup.create({
    data: {
      userId: OWNER_ID,
      type,
      data: encrypt(JSON.stringify(payload)),
    },
  });
  return POST(makeRestoreRequest(backup.id) as never, {
    params: Promise.resolve({ id: backup.id }),
  });
}

describe("mood backup round trip", () => {
  it("brings the note, the timezone, the sync counter and both tag arms back", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await seedOwner(prisma);
    const { seededTag, ownTag, factor } = await seedTaxonomy(prisma);

    await prisma.moodEntry.create({
      data: {
        id: "mood-rt-entry",
        userId: OWNER_ID,
        date: "2026-07-19",
        mood: "OKAY",
        score: 3,
        // All five level-A values, and deliberately not the ones the label
        // would derive: a restore that re-derived them instead of carrying
        // them would look right on this row and be wrong on every row where
        // the person disagreed with their own five-point pick.
        moodA1: 4,
        stressA2: 9,
        energyA3: 2,
        connectionA4: 6,
        stabilityA5: 0,
        tags: JSON.stringify(["free-text-tag"]),
        note: null,
        noteEncrypted: encryptNote(NOTE),
        source: "MANUAL",
        externalId: null,
        moodLoggedAt: LOGGED_AT,
        // Not Europe/Berlin: a restore that drops `tz` moves this entry's day
        // boundary by six hours and nothing else in the row shows it.
        tz: "America/New_York",
        syncVersion: 3,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        tagLinks: {
          create: [
            { moodTagId: factor.id, rating: 4 },
            { moodTagId: seededTag.id, rating: null },
            { moodTagId: ownTag.id, rating: null },
          ],
        },
      },
    });
    await prisma.moodEntry.create({
      data: {
        id: "mood-rt-tombstone",
        userId: OWNER_ID,
        date: "2026-07-18",
        mood: "SCHLECHT",
        score: 2,
        source: "MANUAL",
        moodLoggedAt: new Date("2026-07-18T22:00:00.000Z"),
        tz: "America/New_York",
        syncVersion: 5,
        deletedAt: DELETED_AT,
      },
    });

    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });
    const parsed = parseBackupPayload(payload);

    // Wipe what the restore is supposed to bring back. The tag rows stay: the
    // instance's catalogue is reference data, and the account's own tag rides
    // in the file and is re-created by the restore either way.
    await prisma.moodEntry.deleteMany({ where: { userId: OWNER_ID } });
    await prisma.moodTag.deleteMany({ where: { userId: OWNER_ID } });
    expect(await prisma.moodEntry.count({ where: { userId: OWNER_ID } })).toBe(
      0,
    );

    const response = await restoreFromPayload(
      prisma,
      parsed,
      "MOOD_ROUND_TRIP",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { skipped: { links: number } };
    };
    // Nothing was dropped. A restore that lost a link and still answered 200
    // is exactly what the skip report exists to make visible.
    expect(body.data.skipped.links).toBe(0);

    const restored = await prisma.moodEntry.findUniqueOrThrow({
      where: { id: "mood-rt-entry" },
    });
    // Asserted as "there is a note" before it is decrypted, so a payload that
    // stopped carrying the ciphertext fails by name rather than as a TypeError
    // three frames inside the cipher.
    expect(
      restored.noteEncrypted,
      "the restored entry has no note ciphertext — the backup dropped it",
    ).not.toBeNull();
    expect(decryptFromBytes(restored.noteEncrypted!)).toBe(NOTE);
    expect(restored.note).toBeNull();
    expect(restored.tz).toBe("America/New_York");
    expect(restored.syncVersion).toBe(3);
    expect(restored.moodLoggedAt).toEqual(LOGGED_AT);
    expect(restored.createdAt).toEqual(CREATED_AT);
    expect(restored.updatedAt).toEqual(UPDATED_AT);
    expect(restored.date).toBe("2026-07-19");
    expect(restored.score).toBe(3);
    // Each of the five asserted by value. Zero is included on purpose: it is a
    // real answer on this scale, and a carrier that treated it as absence
    // would round-trip it as NULL and pass a truthiness check.
    expect(restored.moodA1).toBe(4);
    expect(restored.stressA2).toBe(9);
    expect(restored.energyA3).toBe(2);
    expect(restored.connectionA4).toBe(6);
    expect(restored.stabilityA5).toBe(0);
    expect(restored.tags).toBe(JSON.stringify(["free-text-tag"]));
    expect(restored.deletedAt).toBeNull();

    const tombstone = await prisma.moodEntry.findUniqueOrThrow({
      where: { id: "mood-rt-tombstone" },
    });
    expect(tombstone.deletedAt).toEqual(DELETED_AT);
    expect(tombstone.syncVersion).toBe(5);
    // The tombstone was written without level-A values and comes back without
    // them. A restore filling these in would put an answer nobody gave into a
    // row the person had already deleted.
    expect(tombstone.moodA1).toBeNull();
    expect(tombstone.stressA2).toBeNull();

    const links = await prisma.moodEntryTagLink.findMany({
      where: { moodEntryId: "mood-rt-entry" },
      select: { rating: true, moodTag: { select: { key: true, kind: true } } },
      orderBy: { moodTagId: "asc" },
    });
    const byKey = new Map(links.map((l) => [l.moodTag.key, l]));
    expect([...byKey.keys()].sort()).toEqual([
      "custom:rt_long_walk",
      "rt_headache",
      "rt_sleep_quality",
    ]);
    // The rating is what tells the two arms apart in the row: a ticked tag
    // carries NULL, and that NULL is what the old backup filter read as
    // "nothing to carry".
    expect(byKey.get("rt_headache")!.rating).toBeNull();
    expect(byKey.get("custom:rt_long_walk")!.rating).toBeNull();
    expect(byKey.get("rt_sleep_quality")!.rating).toBe(4);
  });

  it("restores a file written in the shape that predates these fields", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await seedOwner(prisma);
    const { factor } = await seedTaxonomy(prisma);

    // Verbatim the shape the builder emitted before this change: no `note`, no
    // `noteEncrypted`, no `tz`, no `syncedAt`, no `syncVersion`, no
    // `createdAt`/`updatedAt`, no `structuredTags`. Hand-written rather than
    // generated, because a fixture built from today's builder cannot describe
    // yesterday's file.
    const legacyPayload = {
      schemaVersion: "2",
      exportedAt: "2026-07-20T00:00:00.000Z",
      userId: OWNER_ID,
      appSettings: null,
      measurements: [],
      medications: [],
      intakeEvents: [],
      moodEntries: [
        {
          id: "mood-rt-legacy",
          date: "2026-07-19",
          mood: "GUT",
          score: 4,
          tags: null,
          source: "MOODLOG",
          loggedAt: LOGGED_AT.toISOString(),
          externalId: "moodlog-legacy",
          deletedAt: null,
          factors: [{ key: factor.key, rating: 5 }],
        },
      ],
      customMoodTags: [],
      nutrientDays: [],
    };

    const parsed = parseBackupPayload(legacyPayload);
    // Defaults, not values: absence has to stay absence through the parse.
    expect(parsed.moodEntries[0].structuredTags).toEqual([]);
    expect(parsed.moodEntries[0].tz).toBeUndefined();
    expect(parsed.moodEntries[0].syncVersion).toBeUndefined();
    expect(parsed.moodEntries[0].a1).toBeUndefined();

    const response = await restoreFromPayload(
      prisma,
      parsed,
      "MOOD_LEGACY_SHAPE",
    );
    expect(response.status).toBe(200);

    const restored = await prisma.moodEntry.findUniqueOrThrow({
      where: { id: "mood-rt-legacy" },
    });
    // Identical to what the old restore wrote for the same file: the note
    // columns empty, `tz` NULL — which is what such a row meant, the legacy
    // Europe/Berlin reading — and the counter at the schema default.
    expect(restored.note).toBeNull();
    expect(restored.noteEncrypted).toBeNull();
    expect(restored.tz).toBeNull();
    expect(restored.syncVersion).toBe(0);
    expect(restored.mood).toBe("GUT");
    expect(restored.score).toBe(4);
    expect(restored.externalId).toBe("moodlog-legacy");
    expect(restored.deletedAt).toBeNull();
    // A file from before these columns carries no answer for them, and the
    // restore does not invent one. `GUT` would derive to 7; a restore that
    // derived instead of carrying would write a number this file never held.
    expect(restored.moodA1).toBeNull();
    expect(restored.stressA2).toBeNull();
    expect(restored.energyA3).toBeNull();
    expect(restored.connectionA4).toBeNull();
    expect(restored.stabilityA5).toBeNull();

    const links = await prisma.moodEntryTagLink.findMany({
      where: { moodEntryId: "mood-rt-legacy" },
      select: { rating: true, moodTagId: true },
    });
    expect(links).toEqual([{ moodTagId: factor.id, rating: 5 }]);
  });

  it("names a ticked tag this instance cannot resolve instead of losing it quietly", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await seedOwner(prisma);
    await seedTaxonomy(prisma);

    const payload = {
      schemaVersion: "2",
      exportedAt: "2026-07-20T00:00:00.000Z",
      userId: OWNER_ID,
      appSettings: null,
      measurements: [],
      medications: [],
      intakeEvents: [],
      moodEntries: [
        {
          id: "mood-rt-unknown-tag",
          date: "2026-07-19",
          mood: "OKAY",
          score: 3,
          tags: null,
          source: "MANUAL",
          loggedAt: LOGGED_AT.toISOString(),
          externalId: null,
          deletedAt: null,
          factors: [],
          structuredTags: ["rt_headache", "rt_retired_tag"],
        },
      ],
      customMoodTags: [],
      nutrientDays: [],
    };

    const response = await restoreFromPayload(
      prisma,
      parseBackupPayload(payload),
      "MOOD_UNKNOWN_TAG",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        skipped: {
          links: number;
          catalogueKeys: Array<{
            catalogue: string;
            key: string;
            links: number;
          }>;
        };
      };
    };
    expect(body.data.skipped.catalogueKeys).toEqual([
      { catalogue: "moodTag", key: "rt_retired_tag", links: 1 },
    ]);
    expect(body.data.skipped.links).toBe(1);

    // The entry itself came back whole. One key that has nowhere to attach
    // costs the link, never the record.
    const restored = await prisma.moodEntry.findUniqueOrThrow({
      where: { id: "mood-rt-unknown-tag" },
    });
    expect(restored.score).toBe(3);
    const links = await prisma.moodEntryTagLink.findMany({
      where: { moodEntryId: restored.id },
      select: { moodTag: { select: { key: true } } },
    });
    expect(links).toEqual([{ moodTag: { key: "rt_headache" } }]);
  });
});
