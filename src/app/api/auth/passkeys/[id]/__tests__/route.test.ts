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

import { PATCH } from "../route";
import { requireAuth } from "@/lib/api-handler";
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

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({ user: USER } as never);
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
