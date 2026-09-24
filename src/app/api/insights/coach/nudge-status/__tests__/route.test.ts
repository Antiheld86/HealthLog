/**
 * GET /api/insights/coach/nudge-status — the NEXT_APP_OPEN evaluation
 * hook. This poll mounts with the app chrome, which makes it the
 * app-open signal, so the route runs the context evaluation before it
 * computes the unread flag (owner only — a delegate opening the record
 * is not the owner opening their app).
 *
 * Watched red: with the `evaluateCoachContextReminders` call removed
 * from the route the first test fails on the hook assertion — the
 * pre-fix state where NEXT_APP_OPEN reminders could never fire.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireRecordAuth, evaluateContext, readStatus, getAiCapability } =
  vi.hoisted(() => ({
    requireRecordAuth: vi.fn(),
    evaluateContext: vi.fn(async () => ({ surfaced: 0, errored: 0 })),
    readStatus: vi.fn(
      async (): Promise<{ unread: boolean; nudgedAt: string | null }> => ({
        unread: false,
        nudgedAt: null,
      }),
    ),
    getAiCapability: vi.fn(),
  }));

const AVAILABLE = { available: true, reason: null, onDeviceAllowed: true };

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireRecordAuth,
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({ getAiCapability }));
vi.mock("@/lib/ai/coach/nudge-status", () => ({
  readCoachNudgeStatus: readStatus,
}));
vi.mock("@/lib/ai/coach/context-reminders", () => ({
  evaluateCoachContextReminders: evaluateContext,
}));
vi.mock("@/lib/db", () => ({ prisma: { __tag: "prisma" } }));
vi.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown) => ({ data, error: null }),
}));

import { GET } from "../route";

beforeEach(() => {
  vi.clearAllMocks();
  readStatus.mockResolvedValue({ unread: false, nudgedAt: null });
  getAiCapability.mockResolvedValue(AVAILABLE);
});

describe("nudge-status — NEXT_APP_OPEN hook", () => {
  it("runs the app-open evaluation for the owner BEFORE computing the unread flag", async () => {
    requireRecordAuth.mockResolvedValue({
      user: { id: "u1" },
      actor: { id: "u1" },
    });

    await (GET as unknown as () => Promise<unknown>)();

    expect(evaluateContext).toHaveBeenCalledTimes(1);
    const [prismaArg, userId, trigger] = evaluateContext.mock
      .calls[0] as unknown as [{ __tag: string }, string, string];
    expect(prismaArg.__tag).toBe("prisma");
    expect(userId).toBe("u1");
    expect(trigger).toBe("app-open");
    // Ordering: the surfaced message must be visible to this very read.
    expect(evaluateContext.mock.invocationCallOrder[0]).toBeLessThan(
      readStatus.mock.invocationCallOrder[0]!,
    );
  });

  it("never satisfies the cue for a switched caller", async () => {
    requireRecordAuth.mockResolvedValue({
      user: { id: "owner" },
      actor: { id: "delegate" },
    });

    await (GET as unknown as () => Promise<unknown>)();

    expect(evaluateContext).not.toHaveBeenCalled();
    expect(readStatus).toHaveBeenCalledWith("owner");
  });

  it("keeps the badge alive when the evaluator fails", async () => {
    requireRecordAuth.mockResolvedValue({
      user: { id: "u1" },
      actor: { id: "u1" },
    });
    evaluateContext.mockRejectedValueOnce(new Error("evaluator down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = (await (GET as unknown as () => Promise<unknown>)()) as {
        error: null;
      };
      expect(res.error).toBeNull();
      expect(readStatus).toHaveBeenCalledWith("u1");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("nudge-status — the coach capability", () => {
  it("adds the resolved state beside the unread signal while available", async () => {
    requireRecordAuth.mockResolvedValue({
      user: { id: "u1" },
      actor: { id: "u1" },
    });
    readStatus.mockResolvedValue({ unread: true, nudgedAt: "2026-07-18" });

    const res = (await (GET as unknown as () => Promise<unknown>)()) as {
      data: Record<string, unknown>;
    };

    expect(getAiCapability).toHaveBeenCalledWith("coach");
    expect(res.data).toEqual({
      unread: true,
      nudgedAt: "2026-07-18",
      ai: AVAILABLE,
    });
  });

  it.each(["operator_disabled", "user_disabled", "no_provider"] as const)(
    "answers the quiet 200 shape for %s, reading and evaluating nothing",
    async (reason) => {
      requireRecordAuth.mockResolvedValue({
        user: { id: "u1" },
        actor: { id: "u1" },
      });
      const ai = { available: false, reason, onDeviceAllowed: false };
      getAiCapability.mockResolvedValue(ai);

      const res = (await (GET as unknown as () => Promise<unknown>)()) as {
        data: Record<string, unknown>;
        error: null;
      };

      expect(res.error).toBeNull();
      expect(res.data).toEqual({
        nudgedAt: null,
        unread: false,
        conversationId: null,
        ai,
      });
      expect(readStatus).not.toHaveBeenCalled();
      expect(evaluateContext).not.toHaveBeenCalled();
    },
  );
});
