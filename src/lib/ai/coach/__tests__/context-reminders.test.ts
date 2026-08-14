/**
 * Context-cue evaluation for Coach reminders — the evaluator the capture
 * grammar promised since v1.22 and never had.
 *
 * Watched red: with `evaluateCoachContextReminders` gutted to return
 * `{ surfaced: 0, errored: 0 }` unconditionally (the pre-fix reality —
 * captured, confirmed, never fired), every surfacing test below fails
 * naming the missing conversation write. Verified red against that stub.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: (buf: Uint8Array) => Buffer.from(buf).toString("utf8"),
  encryptToBytes: (s: string) => new Uint8Array(Buffer.from(`enc:${s}`)),
}));

import {
  APP_OPEN_GRACE_MS,
  evaluateCoachContextReminders,
} from "../context-reminders";

const NOW = new Date("2026-06-27T12:00:00.000Z");

function bytes(tag: string): Uint8Array {
  return new Uint8Array(Buffer.from(tag, "utf8"));
}

function minutesBefore(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * 60 * 1000);
}

function makePrisma(options: {
  reminders?: {
    id: string;
    noteEncrypted: Uint8Array;
    contextCue: string;
    createdAt: Date;
  }[];
  /** Measurement evidence per findFirst call: null = none. */
  evidence?: { id: string } | null;
}) {
  const tx = {
    coachConversation: { create: vi.fn(async () => ({ id: "c1" })) },
    coachMessage: { create: vi.fn(async () => ({ id: "m1" })) },
    coachReminder: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    coachReminder: {
      findMany: vi.fn(async () => options.reminders ?? []),
    },
    measurement: {
      findFirst: vi.fn(async () => options.evidence ?? null),
    },
    user: { findUnique: vi.fn(async () => ({ locale: "en" })) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
    tx,
  };
  return prisma;
}

describe("evaluateCoachContextReminders — measurement cues", () => {
  it("surfaces a NEXT_WEIGHT_LOGGED reminder when a matching row was logged after capture", async () => {
    const createdAt = minutesBefore(NOW, 60);
    const prisma = makePrisma({
      reminders: [
        {
          id: "r1",
          noteEncrypted: bytes("check in on the diet"),
          contextCue: "NEXT_WEIGHT_LOGGED",
          createdAt,
        },
      ],
      evidence: { id: "m-weight" },
    });

    const outcome = await evaluateCoachContextReminders(
      prisma as never,
      "u1",
      "measurement",
      NOW,
    );

    expect(outcome.surfaced).toBe(1);
    // Evidence query: matching types, live rows only, logged AFTER capture
    // (row createdAt, not measuredAt — back-dating still counts as logging).
    expect(prisma.measurement.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "u1",
          type: { in: ["WEIGHT"] },
          deletedAt: null,
          createdAt: { gt: createdAt },
        }),
      }),
    );
    // Delivered through the shared surfacing transaction: message + flip.
    expect(prisma.tx.coachMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.tx.coachReminder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["r1"] } },
        data: expect.objectContaining({ status: "surfaced" }),
      }),
    );
  });

  it("leaves the reminder untouched when no matching measurement exists", async () => {
    const prisma = makePrisma({
      reminders: [
        {
          id: "r1",
          noteEncrypted: bytes("check in on the diet"),
          contextCue: "NEXT_BP_LOGGED",
          createdAt: minutesBefore(NOW, 60),
        },
      ],
      evidence: null,
    });

    const outcome = await evaluateCoachContextReminders(
      prisma as never,
      "u1",
      "measurement",
      NOW,
    );

    expect(outcome.surfaced).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("never evaluates NEXT_APP_OPEN on the measurement trigger", async () => {
    const prisma = makePrisma({ reminders: [] });
    await evaluateCoachContextReminders(
      prisma as never,
      "u1",
      "measurement",
      NOW,
    );
    const where = (
      prisma.coachReminder.findMany.mock.calls[0] as unknown as [
        { where: { contextCue: { in: string[] } } },
      ]
    )[0].where;
    expect(where.contextCue.in).not.toContain("NEXT_APP_OPEN");
  });
});

describe("evaluateCoachContextReminders — app open", () => {
  it("surfaces a NEXT_APP_OPEN reminder once the capture grace has passed", async () => {
    const prisma = makePrisma({
      reminders: [
        {
          id: "r2",
          noteEncrypted: bytes("look at the sleep chart"),
          contextCue: "NEXT_APP_OPEN",
          createdAt: new Date(NOW.getTime() - APP_OPEN_GRACE_MS),
        },
      ],
    });

    const outcome = await evaluateCoachContextReminders(
      prisma as never,
      "u1",
      "app-open",
      NOW,
    );

    expect(outcome.surfaced).toBe(1);
    // The app-open leg needs no measurement evidence.
    expect(prisma.measurement.findFirst).not.toHaveBeenCalled();
    expect(prisma.tx.coachMessage.create).toHaveBeenCalledTimes(1);
  });

  it("stays quiet inside the capture grace — the session that created it is not the next open", async () => {
    const prisma = makePrisma({
      reminders: [
        {
          id: "r2",
          noteEncrypted: bytes("look at the sleep chart"),
          contextCue: "NEXT_APP_OPEN",
          createdAt: minutesBefore(NOW, 1),
        },
      ],
    });

    const outcome = await evaluateCoachContextReminders(
      prisma as never,
      "u1",
      "app-open",
      NOW,
    );

    expect(outcome.surfaced).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
