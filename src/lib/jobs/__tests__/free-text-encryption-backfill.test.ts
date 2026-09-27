import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readNote } from "@/lib/crypto/note-cipher";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";

// ── in-memory store backing a minimal prisma mock ──────────────────────────
interface ConversationRow {
  id: string;
  userId: string;
  title: string | null;
  titleEncrypted: Uint8Array | null;
}
interface EntryRow {
  id: string;
  userId: string;
  note: string | null;
  noteEncrypted: Uint8Array | null;
}

const store = vi.hoisted(() => ({
  conversations: [] as ConversationRow[],
  entries: [] as EntryRow[],
}));

vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: () => null }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

vi.mock("@/lib/db", () => {
  function delegate<R extends { id: string; userId: string }>(
    rows: () => R[],
    readable: keyof R,
  ) {
    return {
      // The handler pages on `{ userId, <readable>: { not: null } }`.
      findMany: async (args: { where: { userId: string }; take: number }) =>
        rows()
          .filter((r) => r.userId === args.where.userId && r[readable] !== null)
          .slice(0, args.take)
          .map((r) => ({ id: r.id })),
      findUnique: async (args: { where: { id: string } }) =>
        rows().find((x) => x.id === args.where.id) ?? null,
      update: async (args: { where: { id: string }; data: Partial<R> }) => {
        const r = rows().find((x) => x.id === args.where.id)!;
        Object.assign(r, args.data);
        return r;
      },
    };
  }
  const delegates = {
    coachConversation: delegate(() => store.conversations, "title"),
    customMetricEntry: delegate(() => store.entries, "note"),
  };
  return {
    prisma: {
      ...delegates,
      $transaction: async (fn: (tx: typeof delegates) => unknown) =>
        fn(delegates),
    },
  };
});

import { runFreeTextEncryptionBackfillForUser } from "@/lib/jobs/free-text-encryption-backfill";

const KEY = "a".repeat(64);

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", KEY);
  store.conversations = [
    {
      id: "c1",
      userId: "u1",
      title: "Why is my pressure up after the new tablets?",
      titleEncrypted: null,
    },
    // Already migrated: left alone.
    {
      id: "c2",
      userId: "u1",
      title: null,
      titleEncrypted: encryptToBytes("Sleep this week"),
    },
    { id: "c3", userId: "u2", title: "other user", titleEncrypted: null },
  ];
  store.entries = [
    {
      id: "e1",
      userId: "u1",
      note: "after the long ride",
      noteEncrypted: null,
    },
    { id: "e2", userId: "u1", note: null, noteEncrypted: null }, // no note
    // An empty legacy note is still a readable value; it migrates to "none".
    { id: "e3", userId: "u1", note: "", noteEncrypted: null },
    { id: "e4", userId: "u2", note: "other user", noteEncrypted: null },
  ];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runFreeTextEncryptionBackfillForUser", () => {
  it("seals titles and notes, nulls the readable column, and reads back the same text", async () => {
    const summary = await runFreeTextEncryptionBackfillForUser("u1");

    expect(summary).toEqual({
      conversationTitlesMigrated: 1,
      metricNotesMigrated: 2,
    });

    const c1 = store.conversations.find((r) => r.id === "c1")!;
    expect(c1.title).toBeNull();
    expect(readNote(c1.titleEncrypted, null)).toBe(
      "Why is my pressure up after the new tablets?",
    );

    const e1 = store.entries.find((r) => r.id === "e1")!;
    expect(e1.note).toBeNull();
    expect(readNote(e1.noteEncrypted, null)).toBe("after the long ride");

    const e3 = store.entries.find((r) => r.id === "e3")!;
    expect(e3.note).toBeNull();
    expect(e3.noteEncrypted).toBeNull();
  });

  it("keeps an already sealed row and a row without a note as they were", async () => {
    const before = store.conversations.find(
      (r) => r.id === "c2",
    )!.titleEncrypted;
    await runFreeTextEncryptionBackfillForUser("u1");
    const c2 = store.conversations.find((r) => r.id === "c2")!;
    expect(c2.titleEncrypted).toBe(before);
    const e2 = store.entries.find((r) => r.id === "e2")!;
    expect(e2).toMatchObject({ note: null, noteEncrypted: null });
  });

  it("seals the readable value when a row holds both, since only an older writer can have put it there", async () => {
    store.conversations[1].title = "Renamed by the previous release";
    await runFreeTextEncryptionBackfillForUser("u1");
    const c2 = store.conversations.find((r) => r.id === "c2")!;
    expect(c2.title).toBeNull();
    expect(readNote(c2.titleEncrypted, null)).toBe(
      "Renamed by the previous release",
    );
  });

  it("does not touch another account's rows", async () => {
    await runFreeTextEncryptionBackfillForUser("u1");
    expect(store.conversations.find((r) => r.id === "c3")).toMatchObject({
      title: "other user",
      titleEncrypted: null,
    });
    expect(store.entries.find((r) => r.id === "e4")).toMatchObject({
      note: "other user",
      noteEncrypted: null,
    });
  });

  it("is idempotent: a second run changes nothing", async () => {
    await runFreeTextEncryptionBackfillForUser("u1");
    const sealed = store.conversations.find(
      (r) => r.id === "c1",
    )!.titleEncrypted;
    const second = await runFreeTextEncryptionBackfillForUser("u1");
    expect(second).toEqual({
      conversationTitlesMigrated: 0,
      metricNotesMigrated: 0,
    });
    expect(store.conversations.find((r) => r.id === "c1")!.titleEncrypted).toBe(
      sealed,
    );
  });

  it("is fail-closed: without a key every readable row stays intact", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    vi.stubEnv("ENCRYPTION_KEYS", "");
    await expect(runFreeTextEncryptionBackfillForUser("u1")).rejects.toThrow();
    expect(store.conversations.find((r) => r.id === "c1")).toMatchObject({
      title: "Why is my pressure up after the new tablets?",
      titleEncrypted: null,
    });
  });
});
