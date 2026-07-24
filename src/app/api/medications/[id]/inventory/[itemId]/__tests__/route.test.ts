/**
 * v1.4.43 W6 — multi-issue 422 envelope on PATCH
 * /api/medications/[id]/inventory/[itemId].
 *
 * v1.16.1 — stock-correction contract: `unitsRemaining` sets the count
 * absolutely, clamps to `unitsTotal`, and the canonical state machine
 * derives the next state (0 ⇒ USED_UP).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => {
  // v1.32.22 (M5) — the PATCH / DELETE now run inside `prisma.$transaction`
  // that takes the per-medication advisory lock. The mock transaction runs the
  // callback with the base client as the tx, so the existing model mocks apply
  // inside the transaction and `$queryRaw` (the advisory lock) is observable.
  const prisma: Record<string, unknown> = {
    medication: { findUnique: vi.fn() },
    medicationInventoryItem: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return { prisma };
});

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/medications/inventory/service", () => ({
  computeExpiresAt: vi.fn().mockReturnValue(null),
  buildPatchInventoryUpdate: vi.fn().mockReturnValue({}),
  // v1.16.12 — the route serialises its Decimal unit columns to numbers
  // on the way out; a passthrough keeps these update-logic assertions
  // focused on the Prisma call, not the response shape.
  serializeInventoryItem: <T>(item: T) => item,
}));
vi.mock("@/lib/medications/route-guards", () => ({
  assertMedicationOwnership: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
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

import { PATCH, DELETE } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";

const prismaTx = prisma as unknown as {
  $queryRaw: ReturnType<typeof vi.fn>;
  $transaction: ReturnType<typeof vi.fn>;
};

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function patchReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/medications/m1/inventory/i1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ROUTE_CTX = {
  params: Promise.resolve({ id: "m1", itemId: "i1" }),
};

beforeEach(() => {
  vi.resetAllMocks();
  // `resetAllMocks` clears the transaction implementation — re-establish it so
  // the callback still runs with the base client as the tx.
  prismaTx.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(prisma.medicationInventoryItem.findUnique).mockResolvedValue({
    id: "i1",
    medicationId: "m1",
    userId: "user-1",
    firstUseAt: null,
    state: "ACTIVE",
    unitsRemaining: 4,
    printedExpiry: null,
  } as never);
});

describe("PATCH /api/medications/[id]/inventory/[itemId] — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Bad `markAsFirstUseAt` iso + bad `markAsUsedUp` (not boolean).
    const res = await PATCH(
      patchReq({ markAsFirstUseAt: "not-iso", markAsUsedUp: "string" }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    const res = await PATCH(
      patchReq({
        markAsFirstUseAt: "not-iso",
        markAsUsedUp: "string",
        printedExpiry: "also-bad",
        notes: 123,
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("PATCH /api/medications/[id]/inventory/[itemId] — unitsRemaining stock correction (v1.16.1)", () => {
  beforeEach(() => {
    vi.mocked(prisma.medicationInventoryItem.findUnique).mockResolvedValue({
      id: "i1",
      medicationId: "m1",
      userId: "user-1",
      firstUseAt: null,
      state: "IN_USE",
      unitsTotal: 4,
      unitsRemaining: 3,
      printedExpiry: null,
      notes: null,
    } as never);
    vi.mocked(prisma.medicationInventoryItem.update).mockImplementation(
      (async (args: { data: Record<string, unknown> }) => ({
        id: "i1",
        ...args.data,
      })) as never,
    );
  });

  it("sets the remaining count absolutely", async () => {
    const res = await PATCH(patchReq({ unitsRemaining: 1 }), ROUTE_CTX);
    expect(res.status).toBe(200);
    const update = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0][0] as unknown as { data: { unitsRemaining: number } };
    expect(update.data.unitsRemaining).toBe(1);
  });

  it("derives USED_UP when corrected to zero", async () => {
    const res = await PATCH(patchReq({ unitsRemaining: 0 }), ROUTE_CTX);
    expect(res.status).toBe(200);
    const update = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0][0] as unknown as {
      data: { unitsRemaining: number; state: string };
    };
    expect(update.data.unitsRemaining).toBe(0);
    expect(update.data.state).toBe("USED_UP");
  });

  it("clamps a raise above the item's capacity to unitsTotal", async () => {
    const res = await PATCH(patchReq({ unitsRemaining: 99 }), ROUTE_CTX);
    expect(res.status).toBe(200);
    const update = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0][0] as unknown as { data: { unitsRemaining: number } };
    expect(update.data.unitsRemaining).toBe(4);
  });

  it("rejects a negative correction with 422", async () => {
    const res = await PATCH(patchReq({ unitsRemaining: -1 }), ROUTE_CTX);
    expect(res.status).toBe(422);
  });
});

describe("PATCH /api/medications/[id]/inventory/[itemId] — carton labelling", () => {
  it("updates manufacturer + doseStrength when supplied", async () => {
    vi.mocked(prisma.medicationInventoryItem.update).mockResolvedValue({
      id: "i1",
      state: "ACTIVE",
    } as never);

    const res = await PATCH(
      patchReq({
        manufacturer: "Example Pharma",
        doseStrength: "5 mg/0.5 ml",
      }),
      ROUTE_CTX,
    );

    expect(res.status).toBe(200);
    const arg = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0]?.[0] as unknown as {
      data: Record<string, unknown>;
    };
    expect(arg.data.manufacturer).toBe("Example Pharma");
    expect(arg.data.doseStrength).toBe("5 mg/0.5 ml");
  });

  it("leaves both untouched when the request omits them", async () => {
    // Absent must mean "I have nothing to say", never "blank it" — a client
    // that does not know the fields must not wipe what another populated.
    vi.mocked(prisma.medicationInventoryItem.update).mockResolvedValue({
      id: "i1",
      state: "ACTIVE",
    } as never);

    const res = await PATCH(patchReq({ unitsRemaining: 2 }), ROUTE_CTX);

    expect(res.status).toBe(200);
    const arg = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0]?.[0] as unknown as {
      data: Record<string, unknown>;
    };
    expect("manufacturer" in arg.data).toBe(false);
    expect("doseStrength" in arg.data).toBe(false);
  });

  it("clears a value on an explicit null", async () => {
    vi.mocked(prisma.medicationInventoryItem.update).mockResolvedValue({
      id: "i1",
      state: "ACTIVE",
    } as never);

    const res = await PATCH(patchReq({ manufacturer: null }), ROUTE_CTX);

    expect(res.status).toBe(200);
    const arg = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0]?.[0] as unknown as {
      data: Record<string, unknown>;
    };
    expect(arg.data.manufacturer).toBeNull();
    expect("doseStrength" in arg.data).toBe(false);
  });
});

/**
 * v1.32.22 (M5) — the stock-correction PATCH and the DELETE route their
 * read-compose-write through the SAME per-medication advisory lock that
 * `consumeForIntake` takes, so an absolute stock write can no longer clobber a
 * concurrent dose decrement. These pin the routing: the write runs inside a
 * transaction that takes the advisory lock BEFORE it reads + writes.
 */
describe("PATCH / DELETE inventory — advisory-lock serialisation (M5)", () => {
  beforeEach(() => {
    vi.mocked(prisma.medicationInventoryItem.findUnique).mockResolvedValue({
      id: "i1",
      medicationId: "m1",
      userId: "user-1",
      firstUseAt: null,
      state: "IN_USE",
      unitsTotal: 4,
      unitsRemaining: 3,
      printedExpiry: null,
      notes: null,
    } as never);
    vi.mocked(prisma.medicationInventoryItem.update).mockImplementation(
      (async (args: { data: Record<string, unknown> }) => ({
        id: "i1",
        ...args.data,
      })) as never,
    );
    vi.mocked(prisma.medicationInventoryItem.delete).mockResolvedValue({
      id: "i1",
    } as never);
  });

  it("takes the medication advisory lock inside a transaction before the write", async () => {
    const res = await PATCH(patchReq({ unitsRemaining: 1 }), ROUTE_CTX);
    expect(res.status).toBe(200);

    // One transaction, one advisory-lock query.
    expect(prismaTx.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaTx.$queryRaw).toHaveBeenCalledTimes(1);

    // The lock SQL is the canonical `pg_advisory_xact_lock` — proves the route
    // shares the intake hook's key rather than re-deriving one.
    const sql = prismaTx.$queryRaw.mock.calls[0]?.[0] as {
      strings?: string[];
    };
    expect((sql.strings ?? []).join("")).toContain("pg_advisory_xact_lock");

    // Lock is acquired BEFORE the row update (serialises against a concurrent
    // consume decrement).
    const lockOrder = prismaTx.$queryRaw.mock.invocationCallOrder[0];
    const updateOrder = vi.mocked(prisma.medicationInventoryItem.update).mock
      .invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(updateOrder);
  });

  it("re-reads the row INSIDE the locked transaction", async () => {
    await PATCH(patchReq({ unitsRemaining: 1 }), ROUTE_CTX);
    // The ownership re-read runs after the lock is taken.
    const lockOrder = prismaTx.$queryRaw.mock.invocationCallOrder[0];
    const readOrder = vi.mocked(prisma.medicationInventoryItem.findUnique).mock
      .invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(readOrder);
  });

  it("DELETE takes the same lock before deleting", async () => {
    const res = await DELETE(patchReq({}), ROUTE_CTX);
    expect(res.status).toBe(200);
    expect(prismaTx.$queryRaw).toHaveBeenCalledTimes(1);
    const lockOrder = prismaTx.$queryRaw.mock.invocationCallOrder[0];
    const deleteOrder = vi.mocked(prisma.medicationInventoryItem.delete).mock
      .invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(deleteOrder);
  });

  it("still 404s an item owned by another user (checked inside the lock)", async () => {
    vi.mocked(prisma.medicationInventoryItem.findUnique).mockResolvedValue({
      id: "i1",
      medicationId: "m1",
      userId: "someone-else",
      state: "IN_USE",
      unitsTotal: 4,
      unitsRemaining: 3,
      printedExpiry: null,
      firstUseAt: null,
      notes: null,
    } as never);

    const res = await PATCH(patchReq({ unitsRemaining: 1 }), ROUTE_CTX);
    expect(res.status).toBe(404);
    expect(prisma.medicationInventoryItem.update).not.toHaveBeenCalled();
  });
});
