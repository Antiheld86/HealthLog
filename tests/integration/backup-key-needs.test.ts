/**
 * A stored backup records the keys its content needs, and the encryption view
 * says a retired key is still needed while any backup lists it.
 *
 * Both ends and the pipe: the copy is written by the real `storeBackupBlob`,
 * the key ids are read from the JSON on its way into the pieces, and the
 * admin status route reads them back. The case the view used to get wrong is
 * the one asserted: every row rotated, the badge said the old key was safe to
 * drop, and a backup still needed it.
 *
 * Mutations that must turn this red: drop the scanner from `storeBackupBlob`
 * (nothing is recorded, the view has no key to name), or leave
 * `retiredKeysStillNeeded` out of `safeToDropRetiredKeys` (the badge says
 * safe again).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetCryptoCacheForTests, encrypt } from "@/lib/crypto";

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

const saved = {
  key: process.env.ENCRYPTION_KEY,
  keys: process.env.ENCRYPTION_KEYS,
  active: process.env.ENCRYPTION_ACTIVE_KEY_ID,
};

function useKeys(active: string) {
  process.env.ENCRYPTION_KEY = "";
  process.env.ENCRYPTION_KEYS = JSON.stringify({
    old: "11".repeat(32),
    cur: "22".repeat(32),
  });
  process.env.ENCRYPTION_ACTIVE_KEY_ID = active;
  _resetCryptoCacheForTests();
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  process.env.ENCRYPTION_KEY = saved.key ?? "";
  process.env.ENCRYPTION_KEYS = saved.keys ?? "";
  process.env.ENCRYPTION_ACTIVE_KEY_ID = saved.active ?? "";
  _resetCryptoCacheForTests();
});

describe("the keys stored backups still need", () => {
  it("names a retired key a backup's content was written under", async () => {
    const prisma = getPrismaClient();
    const admin = await prisma.user.create({
      data: { username: "keys-admin", email: "k@example.test", role: "ADMIN" },
    });
    const session = await prisma.session.create({
      data: { userId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    const { storeBackupBlob } = await import("@/lib/export/store-backup-blob");
    // A copy taken before the rotation: its note was written under "old".
    useKeys("old");
    const note = Buffer.from(encrypt("before"), "utf8").toString("base64");
    // The copy itself is stored after the rotation, so its envelope is
    // sealed under "cur" and only its content needs "old".
    useKeys("cur");
    await storeBackupBlob(
      prisma,
      { userId: admin.id, type: "MANUAL_UPLOAD_KEYS" },
      async (write) => {
        await write('{"userId":"x","measurements":[{"notesEncrypted":');
        await write(`"${note}"}]}`);
      },
    );
    const row = await prisma.dataBackup.findFirstOrThrow({
      where: { type: "MANUAL_UPLOAD_KEYS" },
    });
    expect(row.innerKeyIds).toEqual(["old"]);
    expect(row.innerKeyIdsRecorded).toBe(true);

    const { GET } = await import("@/app/api/admin/encryption/status/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()).data as {
      rotationComplete: boolean;
      safeToDropRetiredKeys: boolean;
      backups: {
        stored: Array<{ keyId: string; copies: number }>;
        retiredKeysStillNeeded: string[];
      };
    };
    expect(body.backups.stored).toEqual([
      expect.objectContaining({ keyId: "old", copies: 1 }),
    ]);
    expect(body.backups.retiredKeysStillNeeded).toEqual(["old"]);
    expect(body.safeToDropRetiredKeys).toBe(false);
  });
});
