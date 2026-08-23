/**
 * `PATCH /api/auth/passkeys/{id}` — the rename's refusal has to name the field.
 *
 * The handler used to answer `apiError("Invalid request", 422)` and throw the
 * Zod issues away, which is the one thing every sibling body-parsing route in
 * this tree does not do. A person renaming a passkey to an empty string and a
 * person pasting 200 characters got the same three words, so the form had
 * nothing to put beside the field and no way to say which rule was broken.
 *
 * These cases pin the multi-issue envelope by its CONTENT — the issue list has
 * to be present and has to point at `name` — rather than by status alone. A
 * status-only assertion would have passed against the flat error it replaced.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (fn: unknown) => fn,
  requireAuth: vi.fn(),
  requireMfaManagementAuth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    passkey: {
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

import { DELETE, PATCH } from "../route";
import { requireAuth, requireMfaManagementAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";

const USER = { id: "user-1", username: "u", passwordHash: "argon2id$…" };

const ROW = {
  id: "pk-1",
  name: "Phone",
  credentialDeviceType: "multiDevice",
  credentialBackedUp: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  lastUsedAt: null,
};

type IssueEnvelope = {
  error: string;
  details?: { issues?: Array<{ path?: unknown; message?: string }> };
};

function mkPatch(body: unknown): Request {
  return new Request("http://localhost/api/auth/passkeys/pk-1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ id: "pk-1" });

type Handler = (
  r: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

const commitElevation = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({ user: USER } as never);
  commitElevation.mockClear().mockResolvedValue(undefined);
  vi.mocked(requireMfaManagementAuth).mockResolvedValue({
    transport: "cookie",
    user: USER,
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
    commitElevation,
  } as never);
});

describe("PATCH /api/auth/passkeys/{id} — the rename refusal", () => {
  it("returns the multi-issue envelope for an empty name", async () => {
    const res = await (PATCH as unknown as Handler)(mkPatch({ name: "" }), {
      params,
    });

    expect(res.status).toBe(422);
    const env = (await res.json()) as IssueEnvelope;
    // The flat refusal this replaces said "Invalid request" and carried no
    // `details` at all, so both halves matter.
    expect(env.error).toBe("Validation failed");
    expect(env.details?.issues?.length).toBeGreaterThan(0);
    expect(JSON.stringify(env.details?.issues)).toContain("name");
    expect(prisma.passkey.update).not.toHaveBeenCalled();
  });

  it("returns the multi-issue envelope for a name over 64 characters", async () => {
    const res = await (PATCH as unknown as Handler)(
      mkPatch({ name: "x".repeat(65) }),
      { params },
    );

    expect(res.status).toBe(422);
    const env = (await res.json()) as IssueEnvelope;
    expect(env.details?.issues?.length).toBeGreaterThan(0);
    expect(JSON.stringify(env.details?.issues)).toContain("name");
    expect(prisma.passkey.update).not.toHaveBeenCalled();
  });

  it("distinguishes the two refusals from each other", async () => {
    // The point of the change: a client can tell WHICH rule was broken. Under
    // the flat error both bodies were byte-identical.
    const tooShort = await (PATCH as unknown as Handler)(
      mkPatch({ name: "" }),
      { params },
    );
    const tooLong = await (PATCH as unknown as Handler)(
      mkPatch({ name: "x".repeat(65) }),
      { params },
    );

    expect(JSON.stringify(await tooShort.json())).not.toBe(
      JSON.stringify(await tooLong.json()),
    );
  });

  it("still renames on a valid name, trimming it first", async () => {
    vi.mocked(prisma.passkey.findUnique).mockResolvedValue({
      userId: USER.id,
    } as never);
    vi.mocked(prisma.passkey.update).mockResolvedValue({
      ...ROW,
      name: "Work laptop",
    } as never);

    const res = await (PATCH as unknown as Handler)(
      mkPatch({ name: "  Work laptop  " }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(prisma.passkey.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: "Work laptop" } }),
    );
  });

  it("does not leak another account's passkey through the rename", async () => {
    vi.mocked(prisma.passkey.findUnique).mockResolvedValue({
      userId: "someone-else",
    } as never);

    const res = await (PATCH as unknown as Handler)(
      mkPatch({ name: "Mine now" }),
      { params },
    );

    expect(res.status).toBe(404);
    expect(prisma.passkey.update).not.toHaveBeenCalled();
  });
});

/**
 * The removal's gate, and what it must NOT be.
 *
 * A passkey is the primary sign-in credential and it came off a plain session,
 * while the second-factor key next door demanded a fresh proof. The route now
 * asks the same gate the second-factor removal asks — but with
 * `freshFactor: "if-enrolled"`, not `true`. That distinction is the whole
 * design: `true` refuses an account with no second factor outright, and most
 * accounts holding a passkey have nothing else enrolled, so `true` would take
 * their own credential list away from them.
 *
 * The gate itself is behavioural and lives against a real database in
 * `tests/integration/step-up-elevation.test.ts` (E14). What is pinned here is
 * what this file can prove without one: the route asks for the right mode, and
 * it spends the proof only when it is actually about to delete.
 *
 * Mutation check: change the option to `true` and the first case goes red; move
 * `commitElevation()` above the ownership check and the third goes red; drop it
 * altogether and the second goes red.
 */
describe("DELETE /api/auth/passkeys/{id} — the removal's gate", () => {
  const mkDelete = () =>
    new Request("http://localhost/api/auth/passkeys/pk-1", {
      method: "DELETE",
    });

  it("asks for the step-up gate in its if-enrolled mode", async () => {
    vi.mocked(prisma.passkey.findUnique).mockResolvedValue({
      id: "pk-1",
      userId: USER.id,
      name: "Phone",
    } as never);
    vi.mocked(prisma.passkey.count).mockResolvedValue(2 as never);
    vi.mocked(prisma.passkey.delete).mockResolvedValue({} as never);

    await (DELETE as unknown as Handler)(mkDelete(), { params });

    expect(requireMfaManagementAuth).toHaveBeenCalledWith({
      freshFactor: "if-enrolled",
    });
    // Not `true`: that arm refuses an account with no second factor, which is
    // a lockout on this route rather than a safeguard.
    expect(requireMfaManagementAuth).not.toHaveBeenCalledWith({
      freshFactor: true,
    });
  });

  it("spends the proof once, on the way to the delete", async () => {
    vi.mocked(prisma.passkey.findUnique).mockResolvedValue({
      id: "pk-1",
      userId: USER.id,
      name: "Phone",
    } as never);
    vi.mocked(prisma.passkey.count).mockResolvedValue(2 as never);
    vi.mocked(prisma.passkey.delete).mockResolvedValue({} as never);

    const res = await (DELETE as unknown as Handler)(mkDelete(), { params });

    expect(res.status).toBe(200);
    expect(commitElevation).toHaveBeenCalledTimes(1);
    expect(prisma.passkey.delete).toHaveBeenCalledWith({
      where: { id: "pk-1" },
    });
  });

  it("does not spend the proof on another account's passkey id", async () => {
    vi.mocked(prisma.passkey.findUnique).mockResolvedValue({
      id: "pk-1",
      userId: "someone-else",
      name: "Not yours",
    } as never);

    const res = await (DELETE as unknown as Handler)(mkDelete(), { params });

    expect(res.status).toBe(404);
    expect(commitElevation).not.toHaveBeenCalled();
    expect(prisma.passkey.delete).not.toHaveBeenCalled();
  });

  it("does not spend the proof when the last credential is refused", async () => {
    vi.mocked(prisma.passkey.findUnique).mockResolvedValue({
      id: "pk-1",
      userId: USER.id,
      name: "Only one",
    } as never);
    vi.mocked(prisma.passkey.count).mockResolvedValue(1 as never);
    vi.mocked(requireMfaManagementAuth).mockResolvedValue({
      transport: "cookie",
      user: { ...USER, passwordHash: null },
      session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
      commitElevation,
    } as never);

    const res = await (DELETE as unknown as Handler)(mkDelete(), { params });

    expect(res.status).toBe(400);
    expect(commitElevation).not.toHaveBeenCalled();
    expect(prisma.passkey.delete).not.toHaveBeenCalled();
  });
});
