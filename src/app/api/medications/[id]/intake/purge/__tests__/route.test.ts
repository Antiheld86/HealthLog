/**
 * v1.5.5 F-1 C-3 — purge route fires the medication cache bundle.
 *
 * Pins the contract the detail-page Verlauf-löschen cascade depends
 * on: dropping the rollup rows is necessary but not sufficient. The
 * analytics + iOS today-tally + dashboard tiles all read off cached
 * shapes that survive the rollup delete for their TTL; the bundle
 * invalidation forces every downstream reader to converge on the
 * post-purge counts in the same tick the user sees the toast.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findUnique: vi.fn() },
    medicationIntakeEvent: { updateMany: vi.fn() },
    medicationComplianceRollup: { deleteMany: vi.fn() },
  },
}));

vi.mock("@/lib/medications/route-guards", () => ({
  assertMedicationOwnership: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// (#22) — silent cross-device intake sync. Mocked so the route test can
// assert the hook without reaching the APNs senders or the coalescing
// timers.
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
}));

import { DELETE } from "../route";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { invalidateUserMedications } from "@/lib/cache/invalidate";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const ROUTE_PARAMS = { params: Promise.resolve({ id: "med-1" }) };

function deleteReq(): NextRequest {
  return new NextRequest(
    "http://localhost/api/medications/med-1/intake/purge",
    {
      method: "DELETE",
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(assertMedicationOwnership).mockResolvedValue(null);
  vi.mocked(prisma.medication.findUnique).mockResolvedValue({
    name: "Test",
  } as never);
  vi.mocked(prisma.medicationIntakeEvent.updateMany).mockResolvedValue({
    count: 7,
  } as never);
  vi.mocked(prisma.medicationComplianceRollup.deleteMany).mockResolvedValue({
    count: 5,
  } as never);
});

describe("DELETE /api/medications/[id]/intake/purge", () => {
  it("returns 200 with the deleted count", async () => {
    const res = await DELETE(deleteReq(), ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ purged: true, count: 7 });

    // (#22) — the purge queues exactly ONE cross-device sync fan-out.
    expect(queueMedicationIntakeSync).toHaveBeenCalledTimes(1);
  });

  it("invalidates the user medication caches on success (F-1 C-3)", async () => {
    await DELETE(deleteReq(), ROUTE_PARAMS);
    // v1.16.8 — the purge is an interactive write, so it hard-evicts the
    // SWR buckets instead of marking them stale.
    expect(invalidateUserMedications).toHaveBeenCalledWith("user-1", {
      evict: true,
    });
  });

  it("returns the 404 from the shared ownership helper without invalidating", async () => {
    vi.mocked(assertMedicationOwnership).mockResolvedValueOnce(
      new Response(null, { status: 404 }) as never,
    );
    const res = await DELETE(deleteReq(), ROUTE_PARAMS);
    expect(res.status).toBe(404);
    expect(prisma.medicationIntakeEvent.updateMany).not.toHaveBeenCalled();
    expect(invalidateUserMedications).not.toHaveBeenCalled();
  });

  // The purge was the one destructive verb in the intake family that removed
  // rows outright: a mis-tap was final, and a client offline at purge time
  // kept every row forever because a row that no longer exists produces no
  // tombstone. Assert the CALL SHAPE rather than a count — a count comes back
  // identical from a `deleteMany`, which is exactly the regression this pins.
  it("tombstones the events instead of removing them", async () => {
    await DELETE(deleteReq(), ROUTE_PARAMS);

    expect(prisma.medicationIntakeEvent.updateMany).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.medicationIntakeEvent.updateMany).mock
      .calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };

    // Scoped to the caller's own rows for this medication, and to LIVE rows
    // only, so a second purge counts zero rather than re-stamping tombstones
    // and re-bumping every syncVersion the clients have already seen.
    expect(call.where).toEqual({
      medicationId: "med-1",
      userId: "user-1",
      deletedAt: null,
    });

    // A tombstone the sync feed can carry: a stamp plus a monotonic bump.
    expect(call.data.deletedAt).toBeInstanceOf(Date);
    expect(call.data.syncVersion).toEqual({ increment: 1 });
  });
});
