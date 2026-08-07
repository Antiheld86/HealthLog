/**
 * v1.18.6 — explicit-completion route (iOS #23 follow-up).
 *
 * Covers: marks done via the shared primitive, idempotent no-op surfaces
 * completed=false, owner-scoped 404 on a cross-user / tombstoned id, and the
 * structural no-double-notify guarantee (the route delegates to
 * `satisfyReminder` and never reaches the notification dispatcher).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1", locale: "en" } })),
  // v1.37.0 — the mutating arms resolve the RECORD at MANAGE. `actor` is the
  // caller and equals `user` for everyone acting on their own reminders,
  // which is what this suite exercises.
  requireRecordAuth: vi.fn(async () => ({
    user: { id: "u1", locale: "en" },
    actor: { id: "u1", locale: "en" },
    grantId: null,
  })),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

const satisfyReminderMock = vi.fn();
vi.mock("@/lib/measurement-reminders/satisfy", () => ({
  satisfyReminder: (...args: unknown[]) => satisfyReminderMock(...args),
}));

const findFirstMock = vi.fn();
const findUserMock = vi.fn();
const findUniqueOrThrowMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    measurementReminder: {
      findFirst: (...a: unknown[]) => findFirstMock(...a),
      findUniqueOrThrow: (...a: unknown[]) => findUniqueOrThrowMock(...a),
    },
    user: { findUnique: (...a: unknown[]) => findUserMock(...a) },
  },
}));

import { POST } from "../route";

const ROW = {
  id: "r1",
  userId: "u1",
  label: "Blutdruck messen",
  measurementType: "BLOOD_PRESSURE_SYS",
  intervalDays: 7,
  rrule: null,
  anchorDate: null,
  endsOn: null,
  origin: "VORSORGE",
  notifyHour: 9,
  location: null,
  nextDueAt: new Date("2026-06-25T07:00:00Z"),
  lastSatisfiedAt: null,
  enabled: true,
  createdAt: new Date("2026-06-01T00:00:00Z"),
  updatedAt: new Date("2026-06-18T00:00:00Z"),
  deletedAt: null,
};

function makeRequest(): NextRequest {
  return new NextRequest(
    "http://localhost/api/measurement-reminders/r1/complete",
    {
      method: "POST",
    },
  );
}

const params = { params: Promise.resolve({ id: "r1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  findUserMock.mockResolvedValue({ timezone: "Europe/Berlin" });
});

describe("POST /api/measurement-reminders/[id]/complete", () => {
  it("marks the reminder done via the shared primitive and returns completed=true", async () => {
    findFirstMock.mockResolvedValue(ROW);
    satisfyReminderMock.mockResolvedValue({
      satisfied: true,
      nextDueAt: new Date("2026-06-25T07:00:00Z"),
    });
    findUniqueOrThrowMock.mockResolvedValue({
      ...ROW,
      lastSatisfiedAt: new Date("2026-06-18T08:00:00Z"),
    });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.completed).toBe(true);
    expect(body.data.reminder.id).toBe("r1");
    expect(body.data.reminder.lastSatisfiedAt).toBe("2026-06-18T08:00:00.000Z");
    // The route delegates to the ONE shared satisfaction primitive.
    expect(satisfyReminderMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: an already-satisfied reminder is a 200 no-op with completed=false", async () => {
    findFirstMock.mockResolvedValue({
      ...ROW,
      lastSatisfiedAt: new Date("2026-06-18T08:00:00Z"),
    });
    // Forward-only guard inside the primitive returns satisfied=false.
    satisfyReminderMock.mockResolvedValue({
      satisfied: false,
      nextDueAt: null,
    });
    findUniqueOrThrowMock.mockResolvedValue({
      ...ROW,
      lastSatisfiedAt: new Date("2026-06-18T08:00:00Z"),
    });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.completed).toBe(false);
    expect(body.data.reminder.id).toBe("r1");
  });

  it("is owner-scoped: a cross-user reminder 404s and never satisfies", async () => {
    findFirstMock.mockResolvedValue({ ...ROW, userId: "someone-else" });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(404);
    expect(satisfyReminderMock).not.toHaveBeenCalled();
  });

  it("404s a tombstoned / missing reminder", async () => {
    findFirstMock.mockResolvedValue(null);

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(404);
    expect(satisfyReminderMock).not.toHaveBeenCalled();
  });
});
