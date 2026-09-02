import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The shared self-context route is available when Coach or Insights can
 * consume it. Coach-only work within that route stays behind the Coach gate.
 */

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1", locale: "en" } })),
}));

const { requireModuleEnabled } = vi.hoisted(() => ({
  requireModuleEnabled: vi.fn(),
}));
vi.mock("@/lib/modules/gate", () => ({ requireModuleEnabled }));

vi.mock("@/lib/api-response", () => ({
  apiError: (error: string, status: number, meta?: unknown) => ({
    data: null,
    error,
    status,
    meta,
  }),
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
  getClientIp: () => "127.0.0.1",
  returnAllZodIssues: (_e: unknown, status: number) => ({
    data: null,
    error: "validation",
    status,
  }),
  safeJson: async (req: Request) => ({ data: await req.json(), error: null }),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
const {
  profileFindUnique,
  profileUpsert,
  userUpdate,
  transaction,
  invalidateInsights,
} = vi.hoisted(() => {
  const profileFindUnique = vi.fn();
  const profileUpsert = vi.fn(async () => ({ updatedAt: new Date(0) }));
  const userUpdate = vi.fn(async () => ({}));
  const tx = {
    userHealthProfile: {
      findUnique: profileFindUnique,
      upsert: profileUpsert,
    },
    user: { update: userUpdate },
  };
  return {
    profileFindUnique,
    profileUpsert,
    userUpdate,
    transaction: vi.fn(async (callback: (client: unknown) => unknown) =>
      callback(tx),
    ),
    invalidateInsights: vi.fn(),
  };
});
vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: transaction,
    userHealthProfile: {
      findUnique: profileFindUnique,
      upsert: profileUpsert,
    },
    user: { update: userUpdate },
  },
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserInsights: invalidateInsights,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: (s: string) => Buffer.from(s),
}));
const emptyCtx = {
  aboutMe: null,
  conditions: null,
  allergies: null,
  coachFocus: null,
};
vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextForUser: vi.fn(async () => emptyCtx),
  filterSelfContextForAi: (
    ctx: Record<string, string | null>,
    includedSections: string[],
  ) => {
    const included = new Set(includedSections);
    return {
      aboutMe: included.has("ABOUT_ME") ? ctx.aboutMe : null,
      conditions: included.has("CONDITIONS") ? ctx.conditions : null,
      allergies: included.has("ALLERGIES") ? ctx.allergies : null,
      coachFocus: included.has("COACH_FOCUS") ? ctx.coachFocus : null,
    };
  },
  getPendingQuestionsForUser: vi.fn(async () => []),
  setPendingQuestionsForUser: vi.fn(async () => true),
}));
vi.mock("@/lib/ai/coach/self-context-questions", () => ({
  deriveClarifyingQuestions: vi.fn(async () => ({
    questions: [],
    source: "none",
  })),
}));

import { GET, PUT } from "../route";
import {
  getPendingQuestionsForUser,
  setPendingQuestionsForUser,
  getSelfContextForUser,
} from "@/lib/ai/coach/about-me";
import { deriveClarifyingQuestions } from "@/lib/ai/coach/self-context-questions";
import { auditLog } from "@/lib/auth/audit";

type Envelope = {
  data: unknown;
  error: string | null;
  status: number;
  meta?: { errorCode?: string; module?: string };
};
const get = GET as unknown as () => Promise<Envelope>;
const put = PUT as unknown as (req: Request) => Promise<Envelope>;

const disabledResponse: Envelope = {
  data: null,
  error: 'Module "coach" is not enabled',
  status: 403,
  meta: { errorCode: "module.disabled", module: "coach" },
};

function putReq(
  body: Record<string, unknown> = {
    aboutMe: "I run daily",
    aiIncludedSections: ["ABOUT_ME"],
  },
): Request {
  return new Request("http://localhost/api/coach/about-me", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("about-me module gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileFindUnique.mockResolvedValue({
      updatedAt: new Date(0),
      aiIncludedSections: ["ABOUT_ME"],
    });
  });

  function setGates(coach: boolean, insights: boolean) {
    requireModuleEnabled.mockImplementation(
      async (_userId: string, module: string) =>
        module === "coach"
          ? coach
            ? { enabled: true }
            : { enabled: false, response: disabledResponse }
          : insights
            ? { enabled: true }
            : { enabled: false, response: disabledResponse },
    );
  }

  it("GET returns 403 when every self-context consumer is disabled", async () => {
    setGates(false, false);
    const res = await get();
    expect(res.status).toBe(403);
    expect(res.meta?.errorCode).toBe("module.disabled");
    expect(requireModuleEnabled).toHaveBeenCalledWith("u1", "coach");
    expect(requireModuleEnabled).toHaveBeenCalledWith("u1", "insights");
  });

  it("GET remains available to an Insights-only account", async () => {
    setGates(false, true);
    const res = await get();
    expect(res.status).toBe(200);
    expect(getPendingQuestionsForUser).not.toHaveBeenCalled();
  });

  it("GET does not consult Insights when Coach is enabled", async () => {
    setGates(true, false);
    const res = await get();
    expect(res.status).toBe(200);
    expect(requireModuleEnabled).not.toHaveBeenCalledWith("u1", "insights");
    expect(getPendingQuestionsForUser).toHaveBeenCalledWith("u1");
  });

  it("PUT returns 403 when every self-context consumer is disabled", async () => {
    setGates(false, false);
    const res = await put(putReq());
    expect(res.status).toBe(403);
    expect(res.meta?.module).toBe("coach");
  });

  it("clears stale Coach questions after an Insights-only exclusion save", async () => {
    setGates(false, true);
    const res = await put(putReq({ aiIncludedSections: ["ABOUT_ME"] }));
    expect(res.status).toBe(200);
    expect(deriveClarifyingQuestions).not.toHaveBeenCalled();
    expect(setPendingQuestionsForUser).toHaveBeenCalledWith(
      "u1",
      null,
      new Date(0),
    );
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: {
        insightsCachedAt: null,
        insightsCachedText: null,
        insightsCachedLocale: null,
      },
    });
    expect(invalidateInsights).toHaveBeenCalledWith("u1");
  });

  it("does not commit an exclusion when persistent cache clearing fails", async () => {
    setGates(false, true);
    const originalSections = ["ABOUT_ME", "CONDITIONS"];
    let persistedSections = originalSections;
    let stagedSections = persistedSections;
    const txProfileUpsert = vi.fn(
      async (args: { update: { aiIncludedSections?: string[] } }) => {
        stagedSections = args.update.aiIncludedSections ?? stagedSections;
        return { updatedAt: new Date(0) };
      },
    );
    transaction.mockImplementationOnce(
      async (callback: (client: unknown) => unknown) => {
        const result = await callback({
          userHealthProfile: {
            findUnique: profileFindUnique,
            upsert: txProfileUpsert,
          },
          user: {
            update: vi.fn(async () => {
              throw new Error("cache clear failed");
            }),
          },
        });
        persistedSections = stagedSections;
        return result;
      },
    );

    await expect(
      put(putReq({ aiIncludedSections: ["ABOUT_ME"] })),
    ).rejects.toThrow("cache clear failed");

    expect(persistedSections).toEqual(originalSections);
    expect(txProfileUpsert).toHaveBeenCalledOnce();
    expect(profileUpsert).not.toHaveBeenCalled();
    expect(invalidateInsights).not.toHaveBeenCalled();
  });

  it("re-scopes pending questions after an inclusion-only update", async () => {
    setGates(true, false);
    vi.mocked(getSelfContextForUser).mockResolvedValueOnce({
      aboutMe: "I run daily",
      conditions: null,
      allergies: null,
      coachFocus: null,
    });

    const res = await put(putReq({ aiIncludedSections: ["ABOUT_ME"] }));

    expect(res.status).toBe(200);
    expect(getPendingQuestionsForUser).not.toHaveBeenCalled();
    expect(deriveClarifyingQuestions).toHaveBeenCalledWith(
      "u1",
      {
        aboutMe: "I run daily",
        conditions: null,
        allergies: null,
        coachFocus: null,
      },
      "en",
      ["ABOUT_ME"],
    );
    expect(setPendingQuestionsForUser).toHaveBeenCalledWith(
      "u1",
      [],
      new Date(0),
    );
  });

  it("clears pending questions when inclusion removes every text field", async () => {
    setGates(true, false);
    profileFindUnique.mockResolvedValue({
      updatedAt: new Date(0),
      aiIncludedSections: [],
    });

    const res = await put(putReq({ aiIncludedSections: [] }));

    expect(res.status).toBe(200);
    expect(deriveClarifyingQuestions).not.toHaveBeenCalled();
    expect(setPendingQuestionsForUser).toHaveBeenCalledWith(
      "u1",
      null,
      new Date(0),
    );
  });

  it("audits an excluded nonempty stored field as updated, not cleared", async () => {
    setGates(true, false);
    profileFindUnique.mockResolvedValue({
      updatedAt: new Date(0),
      aiIncludedSections: [],
    });
    vi.mocked(getSelfContextForUser).mockResolvedValueOnce({
      aboutMe: null,
      conditions: "Asthma",
      allergies: null,
      coachFocus: null,
    });

    const res = await put(putReq({ aboutMe: "" }));

    expect(res.status).toBe(200);
    expect(setPendingQuestionsForUser).toHaveBeenCalledWith(
      "u1",
      null,
      new Date(0),
    );
    expect(auditLog).toHaveBeenCalledWith(
      "coach.about_me.updated",
      expect.objectContaining({ userId: "u1" }),
    );
  });

  it("PUT retains Coach-only derivation when Coach is enabled", async () => {
    setGates(true, false);
    const res = await put(putReq());
    expect(res.status).toBe(200);
    expect(setPendingQuestionsForUser).toHaveBeenCalledWith(
      "u1",
      null,
      new Date(0),
    );
  });
});
