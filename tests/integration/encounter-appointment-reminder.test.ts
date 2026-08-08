/**
 * The appointment arm against real Postgres, through the real routes.
 *
 * Every property here is about ROWS — how many exist, which instant they carry,
 * whether a second call wrote anything — and none of them can be answered by a
 * mocked client. The one that matters most is a count: a reschedule must leave
 * the reminder count at one, and a service that minted a second on every edit
 * would pass any assertion phrased as "the reminder moved".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { POST as createEncounter } from "@/app/api/encounters/route";
import {
  PATCH as patchEncounter,
  DELETE as deleteEncounter,
} from "@/app/api/encounters/[id]/route";
import { GET as listReminders } from "@/app/api/measurement-reminders/route";

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

const OWNER_ID = "appointment-owner";

/** Far enough out that the appointment is still in the future mid-run. */
function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function seedSession() {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      username: "appointment-owner",
      email: "appointment-owner@example.test",
      timezone: "Europe/Berlin",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: OWNER_ID,
      expiresAt: daysFromNow(7),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

function post(body: unknown): Promise<Response> {
  return createEncounter(
    new Request("http://localhost/api/encounters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

function patch(id: string, body: unknown): Promise<Response> {
  return patchEncounter(
    new Request(`http://localhost/api/encounters/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id }) } as never,
  );
}

async function body(res: Response) {
  return (await res.json()) as { data: Record<string, unknown> };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedSession();
});

describe("booking a visit", () => {
  it("mints exactly one reminder, anchored on the appointment", async () => {
    const prisma = getPrismaClient();
    const occurredAt = daysFromNow(14);

    const res = await post({
      occurredAt: occurredAt.toISOString(),
      status: "PLANNED",
      kind: "SPECIALIST",
    });
    expect(res.status).toBe(201);

    const reminders = await prisma.measurementReminder.findMany({
      where: { userId: OWNER_ID },
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.origin).toBe("ENCOUNTER");
    // Both cadence columns NULL is the schema's one-shot: it fires once and
    // the engine can never compute a second occurrence for it.
    expect(reminders[0]!.intervalDays).toBeNull();
    expect(reminders[0]!.rrule).toBeNull();
    expect(reminders[0]!.nextDueAt?.toISOString()).toBe(
      occurredAt.toISOString(),
    );

    const created = (await body(res)).data;
    expect(created.reminderNextDueAt).toBe(occurredAt.toISOString());
  });

  it("does not mint one for a visit that already happened", async () => {
    const prisma = getPrismaClient();
    const res = await post({
      occurredAt: daysFromNow(-3).toISOString(),
      status: "DONE",
    });
    expect(res.status).toBe(201);
    expect(await prisma.measurementReminder.count()).toBe(0);
  });

  it("saves with a date and nothing else", async () => {
    // The product constraint, asserted rather than described: no practitioner,
    // no kind, no reason, no link, and the visit still files.
    const res = await post({ occurredAt: daysFromNow(-1).toISOString() });
    expect(res.status).toBe(201);
    const created = (await body(res)).data;
    expect(created.practitioner).toBeNull();
    expect(created.reason).toBeNull();
    expect(created.status).toBe("DONE");
  });
});

describe("rescheduling", () => {
  it("moves the same row and never mints a second", async () => {
    const prisma = getPrismaClient();
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(14).toISOString(),
          status: "PLANNED",
        }),
      )
    ).data;

    const moved = daysFromNow(21);
    const res = await patch(created.id as string, {
      occurredAt: moved.toISOString(),
    });
    expect(res.status).toBe(200);

    const reminders = await prisma.measurementReminder.findMany({
      where: { userId: OWNER_ID },
    });
    // The count is the assertion. "The reminder moved" would also be true of a
    // service that left the old row behind and minted a fresh one.
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.nextDueAt?.toISOString()).toBe(moved.toISOString());
  });

  it("stops nudging once the visit is cancelled, without deleting the row", async () => {
    const prisma = getPrismaClient();
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(14).toISOString(),
          status: "PLANNED",
        }),
      )
    ).data;

    await patch(created.id as string, { status: "CANCELLED" });

    const reminders = await prisma.measurementReminder.findMany({
      where: { userId: OWNER_ID },
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.enabled).toBe(false);
    expect(reminders[0]!.nextDueAt).toBeNull();
  });

  it("retires the reminder when the visit is deleted", async () => {
    const prisma = getPrismaClient();
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(14).toISOString(),
          status: "PLANNED",
        }),
      )
    ).data;

    const res = await deleteEncounter(
      new Request(`http://localhost/api/encounters/${created.id}`, {
        method: "DELETE",
      }) as never,
      { params: Promise.resolve({ id: created.id as string }) } as never,
    );
    expect(res.status).toBe(200);

    const reminder = await prisma.measurementReminder.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    expect(reminder.deletedAt).not.toBeNull();
    expect(reminder.nextDueAt).toBeNull();
  });
});

describe("closing a checkup by filing a visit", () => {
  async function seedCheckup() {
    return getPrismaClient().measurementReminder.create({
      data: {
        userId: OWNER_ID,
        label: "Annual blood panel",
        intervalDays: 365,
        anchorDate: daysFromNow(-370),
        notifyHour: 9,
        nextDueAt: daysFromNow(-5),
      },
    });
  }

  it("advances the checkup when the visit is filed as done", async () => {
    const prisma = getPrismaClient();
    const checkup = await seedCheckup();

    const res = await post({
      occurredAt: daysFromNow(-1).toISOString(),
      status: "DONE",
      reminderId: checkup.id,
    });
    expect(res.status).toBe(201);

    const after = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: checkup.id },
    });
    expect(after.lastSatisfiedAt).not.toBeNull();
    expect(after.nextDueAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("is idempotent — filing it done twice changes nothing and still succeeds", async () => {
    const prisma = getPrismaClient();
    const checkup = await seedCheckup();
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(-1).toISOString(),
          status: "DONE",
          reminderId: checkup.id,
        }),
      )
    ).data;

    const first = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: checkup.id },
    });

    const res = await patch(created.id as string, { status: "DONE" });
    expect(res.status).toBe(200);

    const second = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: checkup.id },
    });
    expect(second.lastSatisfiedAt?.toISOString()).toBe(
      first.lastSatisfiedAt?.toISOString(),
    );
    expect(second.nextDueAt?.toISOString()).toBe(
      first.nextDueAt?.toISOString(),
    );
  });

  it("refuses a planned visit that also claims to close a checkup", async () => {
    const checkup = await seedCheckup();
    const res = await post({
      occurredAt: daysFromNow(14).toISOString(),
      status: "PLANNED",
      reminderId: checkup.id,
    });
    // A visit that has not happened cannot have closed anything.
    expect(res.status).toBe(422);
  });

  it("refuses an appointment reminder as the checkup to close", async () => {
    const prisma = getPrismaClient();
    await post({
      occurredAt: daysFromNow(14).toISOString(),
      status: "PLANNED",
    });
    const appointment = await prisma.measurementReminder.findFirstOrThrow({
      where: { userId: OWNER_ID, origin: "ENCOUNTER" },
    });

    const res = await post({
      occurredAt: daysFromNow(-1).toISOString(),
      status: "DONE",
      reminderId: appointment.id,
    });
    // Accepting it would let one visit re-point another visit's reminder.
    expect(res.status).toBe(404);
  });
});

describe("the Vorsorge list", () => {
  it("does not show a booked appointment as a checkup", async () => {
    const prisma = getPrismaClient();
    await prisma.measurementReminder.create({
      data: {
        userId: OWNER_ID,
        label: "Annual blood panel",
        intervalDays: 365,
        notifyHour: 9,
        nextDueAt: daysFromNow(30),
      },
    });
    await post({
      occurredAt: daysFromNow(14).toISOString(),
      status: "PLANNED",
    });

    // Two rows exist on the engine; one of them is an appointment.
    expect(await prisma.measurementReminder.count()).toBe(2);

    const res = await listReminders();
    expect(res.status).toBe(200);
    const listed = (await res.json()) as {
      data: Array<{ label: string; origin: string }>;
    };
    // Exactly the checkup. Had the exclusion been missing, the mapper would
    // have thrown and this would be a 500 rather than a wrong list — which is
    // the point of the refusal.
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]!.label).toBe("Annual blood panel");
  });
});
