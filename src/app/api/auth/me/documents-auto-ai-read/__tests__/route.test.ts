import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The auto-read opt-in endpoint, and specifically the catch-up it schedules.
 *
 * The summary job is enqueued at UPLOAD time and no-ops while the flag is OFF,
 * so without a catch-up on the flip the toggle only ever applied to future
 * uploads — a user who filled the vault first saw the switch do nothing. These
 * tests pin that a genuine OFF→ON transition schedules the pass, and that a
 * no-op re-save or a flip to OFF does not.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    consentReceipt: { findFirst: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  getAiCapability: vi.fn(),
}));
vi.mock("@/lib/jobs/document-summary-catchup", () => ({
  enqueueSummaryCatchUp: vi.fn().mockResolvedValue({ enqueued: true }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: () => ({}),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { PATCH } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { getAiCapability } from "@/lib/ai/capabilities/gate";
import { enqueueSummaryCatchUp } from "@/lib/jobs/document-summary-catchup";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function mkPatch(documentsAutoAiRead: boolean): Request {
  return new Request("http://localhost/api/auth/me/documents-auto-ai-read", {
    method: "PATCH",
    body: JSON.stringify({ documentsAutoAiRead }),
    headers: { "Content-Type": "application/json" },
  });
}

/** Seed the flag's value BEFORE the PATCH under test. */
function withPrevious(documentsAutoAiRead: boolean) {
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    documentsAutoAiRead,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.user.update).mockResolvedValue({} as never);
  vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.consentReceipt.create).mockResolvedValue({} as never);
  vi.mocked(getAiCapability).mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
});

describe("PATCH /api/auth/me/documents-auto-ai-read — catch-up scheduling", () => {
  it("schedules a catch-up when the opt-in flips OFF→ON", async () => {
    withPrevious(false);

    const res = await PATCH(mkPatch(true));

    expect(res.status).toBe(200);
    expect(enqueueSummaryCatchUp).toHaveBeenCalledWith("user-1");
    expect(enqueueSummaryCatchUp).toHaveBeenCalledTimes(1);
  });

  it("does not re-schedule when the opt-in was already ON", async () => {
    // Idempotency at the trigger: re-saving an already-ON setting must not
    // queue a second pass over the same documents.
    withPrevious(true);

    await PATCH(mkPatch(true));

    expect(enqueueSummaryCatchUp).not.toHaveBeenCalled();
  });

  it("does not schedule anything when the opt-in is turned OFF", async () => {
    withPrevious(true);

    await PATCH(mkPatch(false));

    expect(enqueueSummaryCatchUp).not.toHaveBeenCalled();
    expect(prisma.consentReceipt.create).not.toHaveBeenCalled();
  });

  it("mints the extraction receipt on the flip that schedules the pass", async () => {
    // The catch-up rides the same act of consent, never around it. The toggle
    // grants document reading only: `ai_extraction`, not the master `ai_full`
    // that would also open the Coach and the AI analysis.
    withPrevious(false);

    await PATCH(mkPatch(true));

    expect(prisma.consentReceipt.create).toHaveBeenCalledTimes(1);
    const data = vi.mocked(prisma.consentReceipt.create).mock.calls[0]![0]
      .data as { userId: string; kind: string };
    expect(data.userId).toBe("user-1");
    expect(data.kind).toBe("ai_extraction");
    // The capability is read after the mint, so the fresh receipt counts.
    const mintOrder = vi.mocked(prisma.consentReceipt.create).mock
      .invocationCallOrder[0]!;
    const readOrder = vi.mocked(getAiCapability).mock.invocationCallOrder[0]!;
    expect(mintOrder).toBeLessThan(readOrder);
  });

  it("does not mint a second receipt when one that covers document reads is active", async () => {
    withPrevious(false);
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue({
      id: "r1",
    } as never);

    await PATCH(mkPatch(true));

    expect(prisma.consentReceipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          revokedAt: null,
          kind: { in: ["ai_extraction", "ai_full"] },
        }),
      }),
    );
    expect(prisma.consentReceipt.create).not.toHaveBeenCalled();
  });

  it("treats a concurrent mint as success", async () => {
    withPrevious(false);
    vi.mocked(prisma.consentReceipt.create).mockRejectedValue({
      code: "P2002",
    });

    const res = await PATCH(mkPatch(true));

    expect(res.status).toBe(200);
  });

  it("saves the preference but schedules no catch-up while document reading is closed", async () => {
    // The operator turned document reading off: every summary the pass would
    // enqueue could only be refused, so it is not enqueued at all.
    withPrevious(false);
    vi.mocked(getAiCapability).mockResolvedValue({
      available: false,
      reason: "operator_disabled",
      onDeviceAllowed: false,
    });

    const res = await PATCH(mkPatch(true));

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalled();
    expect(enqueueSummaryCatchUp).not.toHaveBeenCalled();
  });

  it("persists the flag field-by-field", async () => {
    withPrevious(false);

    await PATCH(mkPatch(true));

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { documentsAutoAiRead: true },
    });
  });
});
