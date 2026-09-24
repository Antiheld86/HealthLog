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
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/consent/web-grant", () => ({
  ensureExtractionConsentReceipt: vi.fn().mockResolvedValue(undefined),
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
import { ensureExtractionConsentReceipt } from "@/lib/consent/web-grant";
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
    expect(ensureExtractionConsentReceipt).not.toHaveBeenCalled();
  });

  it("still mints the consent receipt on the flip that schedules the pass", async () => {
    // The catch-up rides the same act of consent, never around it. The mint
    // is the extraction kind (documents, lab scans, medication text) and
    // nothing wider: switching document reading on does not consent to the
    // Coach or to the analysis. It is the person's own affirmative act, so
    // it may lift an earlier withdrawal of the same kind.
    withPrevious(false);

    await PATCH(mkPatch(true));

    expect(ensureExtractionConsentReceipt).toHaveBeenCalledWith("user-1");
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
