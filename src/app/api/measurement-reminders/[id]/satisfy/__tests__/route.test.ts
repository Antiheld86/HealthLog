/**
 * v1.17.1 — manual "Erledigt" (satisfy) route.
 *
 * Covers: a free-text Vorsorge resolves through the shared primitive,
 * owner-scoped 404 on a cross-user / tombstoned id, and the defense-in-depth
 * screening refusal (a screening reminder may only resolve from the
 * server-written score row, never a crafted manual satisfy).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1", locale: "en" } })),
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
  label: "Blutbild",
  measurementType: null, // free-text Vorsorge (resolves only on a manual satisfy)
  intervalDays: 365,
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
    "http://localhost/api/measurement-reminders/r1/satisfy",
    { method: "POST" },
  );
}

const params = { params: Promise.resolve({ id: "r1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  findUserMock.mockResolvedValue({ timezone: "Europe/Berlin" });
});

describe("POST /api/measurement-reminders/[id]/satisfy", () => {
  it("satisfies a free-text Vorsorge via the shared primitive", async () => {
    findFirstMock.mockResolvedValue(ROW);
    satisfyReminderMock.mockResolvedValue({
      satisfied: true,
      nextDueAt: new Date("2027-06-25T07:00:00Z"),
    });
    findUniqueOrThrowMock.mockResolvedValue({
      ...ROW,
      lastSatisfiedAt: new Date("2026-06-18T08:00:00Z"),
    });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.id).toBe("r1");
    expect(satisfyReminderMock).toHaveBeenCalledTimes(1);
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

  it("refuses a screening reminder with 409 and never satisfies (defense-in-depth)", async () => {
    findFirstMock.mockResolvedValue({ ...ROW, measurementType: "GAD7_SCORE" });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(409);
    expect(satisfyReminderMock).not.toHaveBeenCalled();
  });

  it("still allows a manual satisfy of a typed numeric reminder", async () => {
    findFirstMock.mockResolvedValue({
      ...ROW,
      measurementType: "BLOOD_PRESSURE_SYS",
    });
    satisfyReminderMock.mockResolvedValue({
      satisfied: true,
      nextDueAt: new Date("2026-07-02T07:00:00Z"),
    });
    findUniqueOrThrowMock.mockResolvedValue({
      ...ROW,
      measurementType: "BLOOD_PRESSURE_SYS",
      lastSatisfiedAt: new Date("2026-06-18T08:00:00Z"),
    });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(200);
    expect(satisfyReminderMock).toHaveBeenCalledTimes(1);
  });
});
