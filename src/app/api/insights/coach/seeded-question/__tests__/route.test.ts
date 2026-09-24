import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.21.2 (A3) — the seeded-question route resolves today's single most
 * notable derived signal into a tappable Coach opener, server-side. When the
 * confidence + notability gate yields nothing the route returns
 * `{ signal: null }` and the hero keeps its neutral greeting — never a
 * fabricated opener.
 */
const findUniqueMock = vi.fn().mockResolvedValue({ notificationPrefs: null });
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => findUniqueMock(...args) },
    // No settings row: every assistant switch at its default (on). A switch
    // read that fails now fails closed, so the row has to be readable.
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  resolveModuleMap: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkAnalyticsReadRateLimit: vi
    .fn()
    .mockResolvedValue({ allowed: true, remaining: 119, resetAt: 0 }),
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

// Stub the profile loader + the shared briefing detector so the route test
// stays isolated from the compute tier.
vi.mock("@/lib/insights/derived", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/insights/derived")>()),
  loadBaselineProfile: vi
    .fn()
    .mockResolvedValue({ ageYears: 38, sex: "MALE", heightCm: 180 }),
}));

vi.mock("@/lib/insights/derived-briefing", () => ({
  detectDerivedBriefingSignals: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { detectDerivedBriefingSignals } from "@/lib/insights/derived-briefing";
import { GET } from "../route";

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest(
    new URL("http://localhost/api/insights/coach/seeded-question"),
  );
}

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    locale: "en",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  findUniqueMock.mockResolvedValue({ notificationPrefs: null });
});

describe("GET /api/insights/coach/seeded-question", () => {
  it("returns the most notable signal (the head) when one crosses the gate", async () => {
    vi.mocked(detectDerivedBriefingSignals).mockResolvedValue({
      signals: [
        {
          sourceMetric: "readiness",
          label: "readiness",
          score: 58,
          band: "yellow",
          confidence: 72,
        },
        {
          sourceMetric: "recovery",
          label: "recovery",
          score: 49,
          band: "red",
          confidence: 65,
        },
      ],
    });
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        signal: { sourceMetric: string; score: number; band: string } | null;
      } | null;
      error: string | null;
    };
    expect(body.error).toBeNull();
    expect(body.data?.signal).toEqual({
      sourceMetric: "readiness",
      score: 58,
      band: "yellow",
    });
  });

  it("returns { signal: null } when nothing crosses the gate (neutral fallback)", async () => {
    vi.mocked(detectDerivedBriefingSignals).mockResolvedValue(null);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { signal: unknown } | null;
      error: string | null;
    };
    expect(body.error).toBeNull();
    expect(body.data?.signal).toBeNull();
  });

  it("returns { signal: null } and skips the detector when ambient suggestions are off", async () => {
    findUniqueMock.mockResolvedValue({
      notificationPrefs: { coach: { ambientSuggestions: false } },
    });
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { signal: unknown } | null;
      error: string | null;
    };
    expect(body.error).toBeNull();
    expect(body.data?.signal).toBeNull();
    // The opt-out short-circuits before the compute tier.
    expect(detectDerivedBriefingSignals).not.toHaveBeenCalled();
  });
});
