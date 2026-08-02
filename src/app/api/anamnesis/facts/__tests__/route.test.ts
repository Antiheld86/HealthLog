import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  create: vi.fn(),
  correct: vi.fn(),
  remove: vi.fn(),
  currentFindFirst: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (handler: unknown) => handler,
  requireAuth: vi.fn(async () => ({ user: { id: "user-1" } })),
  // v1.36.0 — the GET resolves a record rather than a caller. Same shape when
  // nobody has switched, which is the case this file exercises.
  requireRecordAuth: vi.fn(async () => ({
    user: { id: "user-1" },
    actor: { id: "user-1" },
    grantId: null,
  })),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency: (handler: unknown) => handler,
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: mocks.audit }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    healthProfileFactRevision: { findFirst: mocks.currentFindFirst },
  },
}));
vi.mock("@/lib/profile/health-facts", () => ({
  readHealthProfileFacts: mocks.read,
  createHealthProfileFact: mocks.create,
  correctHealthProfileFact: mocks.correct,
  removeHealthProfileFact: mocks.remove,
}));

import { GET, POST } from "../route";
import { DELETE, PATCH } from "../[id]/route";

function request(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/anamnesis/facts", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const dto = {
  id: "fact-1",
  kind: "SMOKING_STATUS",
  value: "FORMER",
  unreadable: false,
  validFrom: "2026-07-28T10:00:00.000Z",
  validUntil: null,
  provenance: "USER_REPORTED",
  supersededByRevisionId: null,
  createdAt: "2026-07-28T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({
    current: {
      SMOKING_STATUS: dto,
      ALCOHOL_PATTERN: null,
      SHIFT_SCHEDULE: null,
    },
    history: [dto],
  });
  mocks.create.mockResolvedValue(dto);
  mocks.currentFindFirst.mockResolvedValue({ kind: "SMOKING_STATUS" });
  mocks.correct.mockResolvedValue({
    ...dto,
    id: "fact-2",
    value: "NEVER",
    provenance: "USER_CORRECTION",
  });
  mocks.remove.mockResolvedValue({
    id: "fact-1",
    kind: "SMOKING_STATUS",
    removedAt: "2026-07-28T12:00:00.000Z",
  });
});

describe("anamnesis facts API", () => {
  it("returns current facts together with immutable history", async () => {
    const response = await (GET as unknown as () => Promise<Response>)();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.current.SMOKING_STATUS.value).toBe("FORMER");
    expect(body.data.history).toHaveLength(1);
    expect(mocks.read).toHaveBeenCalledWith("user-1");
  });

  it("accepts only a value from the selected closed fact kind", async () => {
    const response = await (
      POST as unknown as (request: Request) => Promise<Response>
    )(request("POST", { kind: "SMOKING_STATUS", value: "FORMER" }));

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      "user-1",
      "SMOKING_STATUS",
      "FORMER",
    );
    expect(mocks.audit).toHaveBeenCalledOnce();
  });

  it("rejects a value belonging to another fact kind", async () => {
    const response = await (
      POST as unknown as (request: Request) => Promise<Response>
    )(request("POST", { kind: "SMOKING_STATUS", value: "ROTATING" }));

    expect(response.status).toBe(422);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("corrects only the caller's current revision", async () => {
    const response = await (
      PATCH as unknown as (
        request: Request,
        context: { params: Promise<{ id: string }> },
      ) => Promise<Response>
    )(request("PATCH", { value: "NEVER" }), {
      params: Promise.resolve({ id: "fact-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.currentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "fact-1", userId: "user-1" }),
      }),
    );
    expect(mocks.correct).toHaveBeenCalledWith("user-1", "fact-1", "NEVER");
    expect(mocks.audit).toHaveBeenCalledOnce();
  });

  it("does not expose another account's revision as existing", async () => {
    mocks.currentFindFirst.mockResolvedValue(null);
    const response = await (
      PATCH as unknown as (
        request: Request,
        context: { params: Promise<{ id: string }> },
      ) => Promise<Response>
    )(request("PATCH", { value: "NEVER" }), {
      params: Promise.resolve({ id: "other-user-fact" }),
    });

    expect(response.status).toBe(404);
    expect(mocks.correct).not.toHaveBeenCalled();
  });

  it("removes only the caller's current revision and audits metadata without its value", async () => {
    const response = await (
      DELETE as unknown as (
        request: Request,
        context: { params: Promise<{ id: string }> },
      ) => Promise<Response>
    )(request("DELETE"), {
      params: Promise.resolve({ id: "fact-1" }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      id: "fact-1",
      kind: "SMOKING_STATUS",
      removedAt: "2026-07-28T12:00:00.000Z",
    });
    expect(body.data).not.toHaveProperty("value");
    expect(mocks.currentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "fact-1",
          userId: "user-1",
          validUntil: null,
          supersededByRevisionId: null,
        },
      }),
    );
    expect(mocks.remove).toHaveBeenCalledWith("user-1", "fact-1");
    expect(mocks.audit).toHaveBeenCalledWith("anamnesis.fact.remove", {
      userId: "user-1",
      ipAddress: null,
      details: {
        revisionId: "fact-1",
        kind: "SMOKING_STATUS",
      },
    });
    expect(JSON.stringify(mocks.audit.mock.calls[0])).not.toContain("FORMER");
  });

  it("does not expose a missing, closed, or other-owner removal target", async () => {
    mocks.currentFindFirst.mockResolvedValue(null);
    const response = await (
      DELETE as unknown as (
        request: Request,
        context: { params: Promise<{ id: string }> },
      ) => Promise<Response>
    )(request("DELETE"), {
      params: Promise.resolve({ id: "other-user-fact" }),
    });

    expect(response.status).toBe(404);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("returns a conflict when the revision changes after the owner-scoped read", async () => {
    mocks.remove.mockResolvedValue(null);
    const response = await (
      DELETE as unknown as (
        request: Request,
        context: { params: Promise<{ id: string }> },
      ) => Promise<Response>
    )(request("DELETE"), {
      params: Promise.resolve({ id: "fact-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.meta.errorCode).toBe("anamnesis.fact.conflict");
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
