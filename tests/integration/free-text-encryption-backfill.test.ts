/**
 * v1.39.3 — the Coach conversation title and the custom-metric reading note
 * move to AES-256-GCM at rest. Migration 0357 only adds the ciphertext
 * columns; the existing rows are sealed by the boot-time backfill. This runs
 * the real discovery and the real per-user pass against Postgres, with the
 * migrated schema:
 *
 *   - discovery finds exactly the accounts still holding a readable value;
 *   - the pass seals every such row in its own transaction, nulls the readable
 *     column, and reads back the same text;
 *   - a second pass and a second discovery find nothing (it converges);
 *   - a row written the current way is left as it was.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setGlobalBoss } from "@/lib/jobs/boss-instance";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { readNote } from "@/lib/crypto/note-cipher";
import {
  enqueueBootTimeFreeTextEncryptionBackfill,
  runFreeTextEncryptionBackfillForUser,
} from "@/lib/jobs/free-text-encryption-backfill";
import { getPrismaClient, truncateAllTables } from "./setup";

function makeCapturingBoss() {
  const sent: { queue: string; userId: string; startAfter?: number }[] = [];
  const boss = {
    send: async (
      queue: string,
      payload: { userId?: string },
      opts: { startAfter?: number },
    ) => {
      if (payload.userId) sent.push({ queue, userId: payload.userId, ...opts });
      return `job-${sent.length}`;
    },
  };
  return { boss, sent };
}

async function seedUser(id: string) {
  await getPrismaClient().user.create({
    data: {
      id,
      username: id,
      email: `${id}@example.test`,
      timezone: "Europe/Berlin",
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  setGlobalBoss(null as never);
});

describe("free-text encryption backfill (real Postgres)", () => {
  it("discovers, seals, and converges", async () => {
    const prisma = getPrismaClient();
    await Promise.all([seedUser("ft-a"), seedUser("ft-b"), seedUser("ft-c")]);

    // ft-a: a legacy readable title and a sealed one.
    await prisma.coachConversation.create({
      data: { id: "conv-legacy", userId: "ft-a", title: "Legacy title" },
    });
    await prisma.coachConversation.create({
      data: {
        id: "conv-sealed",
        userId: "ft-a",
        titleEncrypted: encryptToBytes("Sealed title"),
      },
    });
    // ft-b: a legacy readable note on a custom-metric reading.
    const metric = await prisma.customMetric.create({
      data: { userId: "ft-b", name: "Grip", unit: "kg" },
    });
    await prisma.customMetricEntry.create({
      data: {
        id: "entry-legacy",
        userId: "ft-b",
        customMetricId: metric.id,
        value: 40,
        unit: "kg",
        measuredAt: new Date("2026-09-01T08:00:00.000Z"),
        note: "legacy note",
      },
    });
    await prisma.customMetricEntry.create({
      data: {
        id: "entry-none",
        userId: "ft-b",
        customMetricId: metric.id,
        value: 41,
        unit: "kg",
        measuredAt: new Date("2026-09-02T08:00:00.000Z"),
      },
    });
    // ft-c: nothing readable, only a sealed title.
    await prisma.coachConversation.create({
      data: { userId: "ft-c", titleEncrypted: encryptToBytes("Only sealed") },
    });

    const first = makeCapturingBoss();
    setGlobalBoss(first.boss as never);
    const discovered = await enqueueBootTimeFreeTextEncryptionBackfill(180);
    expect(discovered.error).toBeNull();
    expect(first.sent.map((s) => s.userId).sort()).toEqual(["ft-a", "ft-b"]);
    // The boot call is deferred past the startup storm.
    expect(first.sent.every((s) => s.startAfter === 180)).toBe(true);

    expect(await runFreeTextEncryptionBackfillForUser("ft-a")).toEqual({
      conversationTitlesMigrated: 1,
      metricNotesMigrated: 0,
    });
    expect(await runFreeTextEncryptionBackfillForUser("ft-b")).toEqual({
      conversationTitlesMigrated: 0,
      metricNotesMigrated: 1,
    });

    const conversations = await prisma.coachConversation.findMany({
      where: { userId: "ft-a" },
      orderBy: { id: "asc" },
    });
    expect(
      conversations.map((c) => ({
        id: c.id,
        readable: c.title,
        text: readNote(c.titleEncrypted, c.title),
      })),
    ).toEqual([
      { id: "conv-legacy", readable: null, text: "Legacy title" },
      { id: "conv-sealed", readable: null, text: "Sealed title" },
    ]);
    const entries = await prisma.customMetricEntry.findMany({
      where: { userId: "ft-b" },
      orderBy: { id: "asc" },
    });
    expect(
      entries.map((e) => ({
        id: e.id,
        readable: e.note,
        text: readNote(e.noteEncrypted, e.note),
      })),
    ).toEqual([
      { id: "entry-legacy", readable: null, text: "legacy note" },
      { id: "entry-none", readable: null, text: null },
    ]);

    // Converged: nothing left to discover, nothing left to seal.
    const second = makeCapturingBoss();
    setGlobalBoss(second.boss as never);
    expect(
      (await enqueueBootTimeFreeTextEncryptionBackfill()).error,
    ).toBeNull();
    expect(second.sent).toEqual([]);
    expect(await runFreeTextEncryptionBackfillForUser("ft-a")).toEqual({
      conversationTitlesMigrated: 0,
      metricNotesMigrated: 0,
    });
  });

  it("uses the partial indexes migration 0357 adds", async () => {
    const indexes = await getPrismaClient().$queryRaw<
      { indexname: string; indexdef: string }[]
    >`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN (
        'coach_conversations_title_backfill_idx',
        'custom_metric_entries_note_backfill_idx'
      )
      ORDER BY indexname`;
    expect(indexes.map((i) => i.indexname)).toEqual([
      "coach_conversations_title_backfill_idx",
      "custom_metric_entries_note_backfill_idx",
    ]);
    expect(indexes[0].indexdef).toContain("WHERE (title IS NOT NULL)");
    expect(indexes[1].indexdef).toContain("WHERE (note IS NOT NULL)");
  });
});
