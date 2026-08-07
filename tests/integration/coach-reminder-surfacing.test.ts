/**
 * The Coach badge and the Coach conversation, over the real assembly.
 *
 * The report: the FAB shows its unread dot, you open the Coach, the
 * conversation is empty, and the dot is still there afterwards. Two separate
 * paths were feeding one indicator — a "is any reminder due?" query lit the
 * dot, while the nightly sweep that made the reminder due wrote nothing into a
 * conversation and had no way to be cleared by opening one.
 *
 * The unit suite can prove the sweep CALLS the right prisma methods; it cannot
 * prove a row exists, that the badge derives from that row, or that opening
 * the Coach clears it. Those three claims are the defect, so they are asserted
 * here against Postgres, through the same functions the cron and the FAB use:
 * `runCoachReminderSweep` writes, `readCoachNudgeStatus` reads, and the seen
 * stamp in between is the one `POST /api/insights/coach/seen` writes.
 *
 * The note text is round-tripped through the real AES codec rather than a
 * mock, so an encoding mistake between the sweep and the conversation reader
 * fails here instead of shipping as an unreadable reminder.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { runCoachReminderSweep } from "@/lib/jobs/coach-reminder-sweep";
import { readCoachNudgeStatus } from "@/lib/ai/coach/nudge-status";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";

const NOW = new Date("2026-08-07T05:20:00.000Z");
const YESTERDAY = new Date("2026-08-06T09:00:00.000Z");

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function seedUser(username: string, locale = "en") {
  return getPrismaClient().user.create({
    data: {
      username,
      email: `${username}@example.test`,
      timezone: "UTC",
      locale,
    },
  });
}

describe("a due Coach reminder reaches the conversation the badge points at", () => {
  it("writes the note as an assistant message, and that message is what makes the badge unread", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("reminder-surfacing");

    await prisma.coachReminder.create({
      data: {
        userId: user.id,
        noteEncrypted: encryptToBytes("ask me about my sleep again"),
        triggerKind: "date",
        dueAt: YESTERDAY,
        status: "active",
        source: "user",
      },
    });

    // Before the sweep there is nothing to be unread ABOUT.
    const before = await readCoachNudgeStatus(user.id);
    expect(before.unread).toBe(false);
    expect(before.conversationId).toBeNull();

    const summary = await runCoachReminderSweep(prisma, NOW);
    expect(summary.remindersDue).toBe(1);
    expect(summary.errored).toBe(0);

    // BOTH ENDS. The row exists…
    const messages = await prisma.coachMessage.findMany({
      where: { conversation: { userId: user.id } },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(decryptFromBytes(messages[0].encryptedContent)).toContain(
      "ask me about my sleep again",
    );

    // …and the badge is derived from THAT row, not from a parallel query.
    const after = await readCoachNudgeStatus(user.id);
    expect(after.unread).toBe(true);
    expect(after.conversationId).toBe(messages[0].conversationId);

    // The reminder is marked surfaced, so it stops being pending work.
    const reminder = await prisma.coachReminder.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(reminder.status).toBe("surfaced");
    expect(reminder.surfaceCount).toBe(1);
  });

  it("opening the Coach clears the badge", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("reminder-seen");
    await prisma.coachReminder.create({
      data: {
        userId: user.id,
        noteEncrypted: encryptToBytes("check the blood pressure trend"),
        triggerKind: "date",
        dueAt: YESTERDAY,
        status: "active",
        source: "user",
      },
    });
    await runCoachReminderSweep(prisma, NOW);
    expect((await readCoachNudgeStatus(user.id)).unread).toBe(true);

    // What `POST /api/insights/coach/seen` writes when the Coach is opened.
    // Anchored on the MESSAGE's own `createdAt`: the sweep takes its `now` for
    // the due-date arithmetic, but the row is stamped by the database, and the
    // route stamps the seen time from the same clock the row came from.
    const written = await prisma.coachMessage.findFirstOrThrow({
      where: { conversation: { userId: user.id } },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { coachLastSeenAt: new Date(written.createdAt.getTime() + 1_000) },
    });

    expect((await readCoachNudgeStatus(user.id)).unread).toBe(false);
  });

  it("does not surface the same reminder twice", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("reminder-idempotent");
    await prisma.coachReminder.create({
      data: {
        userId: user.id,
        noteEncrypted: encryptToBytes("weekly review"),
        triggerKind: "date",
        dueAt: YESTERDAY,
        status: "active",
        source: "user",
      },
    });

    await runCoachReminderSweep(prisma, NOW);
    const second = await runCoachReminderSweep(
      prisma,
      new Date(NOW.getTime() + 86_400_000),
    );

    expect(second.remindersDue).toBe(0);
    expect(
      await prisma.coachMessage.count({
        where: { conversation: { userId: user.id } },
      }),
    ).toBe(1);
  });

  it("takes a reminder an older build left stuck on `due` and gives it the message it promised", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("reminder-legacy");
    await prisma.coachReminder.create({
      data: {
        userId: user.id,
        noteEncrypted: encryptToBytes("the note nobody ever saw"),
        triggerKind: "date",
        dueAt: new Date("2026-05-01T09:00:00.000Z"),
        status: "due",
        lastSurfacedAt: new Date("2026-05-01T05:20:00.000Z"),
        surfaceCount: 1,
        source: "user",
      },
    });

    // This is the reported state exactly: something the UI treated as
    // outstanding, with an empty conversation behind it.
    expect(
      await prisma.coachMessage.count({
        where: { conversation: { userId: user.id } },
      }),
    ).toBe(0);

    await runCoachReminderSweep(prisma, NOW);

    const messages = await prisma.coachMessage.findMany({
      where: { conversation: { userId: user.id } },
    });
    expect(messages).toHaveLength(1);
    expect(decryptFromBytes(messages[0].encryptedContent)).toContain(
      "the note nobody ever saw",
    );
    expect((await readCoachNudgeStatus(user.id)).unread).toBe(true);
  });

  it("keeps a failed write from leaving a badge with nothing behind it", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("reminder-partial");
    const reminder = await prisma.coachReminder.create({
      data: {
        userId: user.id,
        noteEncrypted: encryptToBytes("intact note"),
        triggerKind: "date",
        dueAt: YESTERDAY,
        status: "active",
        source: "user",
      },
    });

    // Fail the transaction the way a real outage would — inside the write, so
    // the conversation, the message and the status flip are all in flight.
    const failing = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          return (arg: unknown) => {
            if (typeof arg === "function") {
              return Promise.reject(new Error("connection reset"));
            }
            const passthrough = Reflect.get(target, prop, receiver) as (
              ops: unknown,
            ) => Promise<unknown>;
            return passthrough.call(target, arg);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const summary = await runCoachReminderSweep(failing as typeof prisma, NOW);
    expect(summary.remindersDue).toBe(0);
    expect(summary.errored).toBe(1);

    // Nothing written, nothing marked — and the badge stays dark, which is the
    // honest state: there is no message to read.
    expect(
      await prisma.coachMessage.count({
        where: { conversation: { userId: user.id } },
      }),
    ).toBe(0);
    const untouched = await prisma.coachReminder.findFirstOrThrow({
      where: { id: reminder.id },
    });
    expect(untouched.status).toBe("active");
    expect((await readCoachNudgeStatus(user.id)).unread).toBe(false);
  });
});
