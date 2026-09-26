/**
 * Two refusals a restore has to make before it changes anything.
 *
 *   1. The file's inner ciphertext was written under a key this host no
 *      longer has. The envelope opens (it is sealed under the current key),
 *      the schema passes, and without the check the restore would write back
 *      rows no reader can open. Refused with the key named; the account keeps
 *      what it had.
 *
 *   2. The file attaches the account's rows to rows another account owns: a
 *      custom mood tag filed under another account's category. The foreign
 *      key is satisfied, so only the tenant check stands in the way. Refused;
 *      the transaction rolls back and the account keeps what it had.
 *
 * Mutations that must turn these red: drop the `keyProblem` refusal in
 * `restoreBackup` (case 1 restores and the note comes back unreadable), or the
 * `assertNoNewForeignReferences` call (case 2 commits the foreign link).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetCryptoCacheForTests, encrypt } from "@/lib/crypto";
import { STORED_BACKUP_SELECT } from "@/lib/export/stored-backup";
import { restoreBackup } from "@/lib/export/restore-backup";

import { getPrismaClient, truncateAllTables } from "./setup";

const saved = {
  key: process.env.ENCRYPTION_KEY,
  keys: process.env.ENCRYPTION_KEYS,
  active: process.env.ENCRYPTION_ACTIVE_KEY_ID,
};

function useKeys(keys: Record<string, string>, active: string) {
  process.env.ENCRYPTION_KEY = "";
  process.env.ENCRYPTION_KEYS = JSON.stringify(keys);
  process.env.ENCRYPTION_ACTIVE_KEY_ID = active;
  _resetCryptoCacheForTests();
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  process.env.ENCRYPTION_KEY = saved.key ?? "";
  process.env.ENCRYPTION_KEYS = saved.keys ?? "";
  process.env.ENCRYPTION_ACTIVE_KEY_ID = saved.active ?? "";
  _resetCryptoCacheForTests();
});

async function seedOwner(username: string) {
  return getPrismaClient().user.create({
    data: { username, email: `${username}@example.test` },
  });
}

async function storeBackup(userId: string, payload: unknown) {
  const prisma = getPrismaClient();
  const row = await prisma.dataBackup.create({
    data: {
      userId,
      type: "MANUAL_UPLOAD_BOUNDARY_TEST",
      data: encrypt(JSON.stringify(payload)),
    },
  });
  return prisma.dataBackup.findUniqueOrThrow({
    where: { id: row.id },
    select: STORED_BACKUP_SELECT,
  });
}

function basePayload(userId: string) {
  return {
    schemaVersion: "1",
    exportedAt: "2026-05-09T10:00:00.000Z",
    userId,
    measurements: [] as unknown[],
    medications: [],
    intakeEvents: [],
    moodEntries: [],
  };
}

describe("restore refuses before it changes anything", () => {
  it("refuses a file whose inner ciphertext needs a key the host dropped", async () => {
    const prisma = getPrismaClient();
    useKeys({ old: "11".repeat(32), cur: "22".repeat(32) }, "old");
    const owner = await seedOwner("key-owner");
    const note = Buffer.from(encrypt("written before the rotation"), "utf8");
    const payload = basePayload(owner.id);
    payload.measurements = [
      {
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: "2026-05-08T07:00:00.000Z",
        source: "MANUAL",
        notesEncrypted: note.toString("base64"),
      },
    ];

    // The rotation ran and the operator dropped the old key; the stored copy's
    // envelope is sealed under the key that remains.
    useKeys({ cur: "22".repeat(32) }, "cur");
    const backup = await storeBackup(owner.id, payload);
    const kept = await prisma.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 99,
        unit: "kg",
        measuredAt: new Date("2026-05-01T07:00:00.000Z"),
        source: "MANUAL",
      },
    });

    const outcome = await restoreBackup({
      backup,
      actorUserId: owner.id,
      ipAddress: null,
      restoreInstanceSettings: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("backup.key.missing");
    expect(outcome.message).toContain("'old'");
    expect(outcome.meta?.keyIds).toEqual(["old"]);

    const rows = await prisma.measurement.findMany({
      where: { userId: owner.id },
    });
    expect(rows.map((r) => r.id)).toEqual([kept.id]);

    // With the key back, the same copy restores and the note opens.
    useKeys({ old: "11".repeat(32), cur: "22".repeat(32) }, "cur");
    const again = await restoreBackup({
      backup,
      actorUserId: owner.id,
      ipAddress: null,
      restoreInstanceSettings: false,
    });
    expect(again.ok).toBe(true);
    const restored = await prisma.measurement.findFirstOrThrow({
      where: { userId: owner.id },
    });
    expect(restored.notesEncrypted).not.toBeNull();
    expect(
      Buffer.from(restored.notesEncrypted!).toString("utf8").startsWith("old."),
    ).toBe(true);
  });

  it("refuses a file that files a tag under another account's category", async () => {
    const prisma = getPrismaClient();
    const owner = await seedOwner("tenant-owner");
    const other = await seedOwner("tenant-other");
    const foreign = await prisma.moodTagCategory.create({
      data: {
        userId: other.id,
        key: "custom:other-category",
        labelKey: "mood.tagCategory.custom",
      },
    });
    const kept = await prisma.moodEntry.create({
      data: {
        userId: owner.id,
        date: "2026-05-01",
        mood: "OKAY",
        score: 3,
        moodLoggedAt: new Date("2026-05-01T20:00:00.000Z"),
      },
    });

    const payload = {
      ...basePayload(owner.id),
      moodEntries: [
        {
          date: "2026-05-08",
          mood: "GUT",
          score: 4,
          tags: null,
          source: "MOODLOG",
          loggedAt: "2026-05-08T20:00:00.000Z",
          structuredTags: ["custom:owner-tag"],
        },
      ],
      customMoodTags: [
        {
          key: "custom:owner-tag",
          labelKey: "mood.tag.custom",
          categoryId: foreign.id,
          kind: "BINARY",
        },
      ],
    };
    const backup = await storeBackup(owner.id, payload);

    const outcome = await restoreBackup({
      backup,
      actorUserId: owner.id,
      ipAddress: null,
      restoreInstanceSettings: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("backup.foreign_reference");

    expect(
      await prisma.moodTag.count({ where: { key: "custom:owner-tag" } }),
    ).toBe(0);
    const moods = await prisma.moodEntry.findMany({
      where: { userId: owner.id },
    });
    expect(moods.map((m) => m.id)).toEqual([kept.id]);
    expect(outcome.message).toContain("mood_tags.category_id");
  });

  it("restores a file whose tag uses the account's own category", async () => {
    const prisma = getPrismaClient();
    const owner = await seedOwner("tenant-own");
    const payload = {
      ...basePayload(owner.id),
      moodEntries: [
        {
          date: "2026-05-08",
          mood: "GUT",
          score: 4,
          tags: null,
          source: "MOODLOG",
          loggedAt: "2026-05-08T20:00:00.000Z",
          structuredTags: ["custom:own-tag"],
        },
      ],
      customMoodTagCategories: [
        {
          id: "own-category-id",
          key: "custom:own-category",
          labelKey: "mood.tagCategory.custom",
        },
      ],
      customMoodTags: [
        {
          key: "custom:own-tag",
          labelKey: "mood.tag.custom",
          categoryId: "own-category-id",
          kind: "BINARY",
        },
      ],
    };
    const backup = await storeBackup(owner.id, payload);
    const outcome = await restoreBackup({
      backup,
      actorUserId: owner.id,
      ipAddress: null,
      restoreInstanceSettings: false,
    });
    expect(outcome.ok).toBe(true);
    const tag = await prisma.moodTag.findUniqueOrThrow({
      where: { key: "custom:own-tag" },
    });
    expect(tag.userId).toBe(owner.id);
  });
});
