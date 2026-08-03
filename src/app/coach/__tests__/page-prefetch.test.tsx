import { afterEach, describe, expect, it, vi } from "vitest";
import { HydrationBoundary, hashKey } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { queryKeys } from "@/lib/query-keys";

/**
 * v1.30.x — the `/coach` server-prefetch key crux + availability gate.
 *
 * The RSC wrapper (`src/app/coach/page.tsx`) dehydrates the coach nudge status
 * under `queryKeys.coachNudgeStatus()` so the auto-open-most-recent decision is
 * available at hydrate (collapsing the nudge → auto-open waterfall). These
 * tests pin: the exact client key; the read is only run when the Coach surface
 * is reachable (operator flag ON + not user-disabled); and every unreachable /
 * error path fails soft. The streaming conversation is never prefetched here.
 */

const getUnswitchedSession = vi.fn();
const requireAssistantSurface = vi.fn();
const readCoachNudgeStatus = vi.fn();

vi.mock("@/lib/auth/acting-carrier", () => ({
  getUnswitchedSession: () => getUnswitchedSession(),
}));
vi.mock("@/lib/feature-flags", () => ({
  requireAssistantSurface: (s: string) => requireAssistantSurface(s),
}));
vi.mock("@/lib/ai/coach/nudge-status", () => ({
  readCoachNudgeStatus: (id: string) => readCoachNudgeStatus(id),
}));
vi.mock("../page-client", () => ({ default: () => null }));

import CoachPage from "../page";

const NUDGE = {
  nudgedAt: "2026-07-18T08:00:00.000Z",
  unread: true,
  conversationId: "c1",
};

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.DASHBOARD_SSR_PREFETCH;
});

function dehydratedQuery(
  el: ReactElement,
): { queryHash: string; state: { data: unknown } } | null {
  if (el.type !== HydrationBoundary) return null;
  const props = el.props as {
    state?: { queries: { queryHash: string; state: { data: unknown } }[] };
  };
  const q = props.state?.queries?.[0];
  return q ? { queryHash: q.queryHash, state: q.state } : null;
}

describe("/coach RSC prefetch", () => {
  it("dehydrates the nudge status under the EXACT client key", async () => {
    getUnswitchedSession.mockResolvedValue({
      user: { id: "u1", disableCoach: false },
    });
    requireAssistantSurface.mockResolvedValue({});
    readCoachNudgeStatus.mockResolvedValue(NUDGE);

    const el = (await CoachPage()) as ReactElement;
    const q = dehydratedQuery(el);
    expect(q).not.toBeNull();
    expect(q!.queryHash).toBe(hashKey(queryKeys.coachNudgeStatus()));
    expect(q!.state.data).toEqual(NUDGE);
  });

  it("skips the prefetch when the user opted out of the Coach", async () => {
    getUnswitchedSession.mockResolvedValue({
      user: { id: "u1", disableCoach: true },
    });
    const el = (await CoachPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(requireAssistantSurface).not.toHaveBeenCalled();
    expect(readCoachNudgeStatus).not.toHaveBeenCalled();
  });

  it("fails soft when the operator Coach flag is off (surface throws)", async () => {
    getUnswitchedSession.mockResolvedValue({
      user: { id: "u1", disableCoach: false },
    });
    requireAssistantSurface.mockRejectedValue(new Error("assistant disabled"));

    const el = (await CoachPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(readCoachNudgeStatus).not.toHaveBeenCalled();
  });

  it("fails soft when the read throws", async () => {
    getUnswitchedSession.mockResolvedValue({
      user: { id: "u1", disableCoach: false },
    });
    requireAssistantSurface.mockResolvedValue({});
    readCoachNudgeStatus.mockRejectedValue(new Error("db blip"));

    const el = (await CoachPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
  });

  // Null also means "acting on somebody else's record" — `getUnswitchedSession`
  // collapses both into the same answer, and the page treats them the same.
  it("fails soft when there is no session", async () => {
    getUnswitchedSession.mockResolvedValue(null);
    const el = (await CoachPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
  });

  it("honours the DASHBOARD_SSR_PREFETCH kill-switch", async () => {
    process.env.DASHBOARD_SSR_PREFETCH = "false";
    const el = (await CoachPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(getUnswitchedSession).not.toHaveBeenCalled();
  });
});
