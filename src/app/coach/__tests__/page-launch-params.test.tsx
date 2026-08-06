import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.31.0 — the `/coach` URL launch params.
 *
 * The page is the full-page half of every cross-surface hand-off (push taps,
 * copied links, the drawer's maximize control), so the params it understands
 * ARE the contract. Two properties matter enough to pin:
 *
 *  - `?scope=` is parsed STRICTLY against the closed `CoachScopeSource` union.
 *    An unknown value is ignored SILENTLY — no error, no crash, no free-form
 *    string reaching the chat route where it would widen the snapshot scope.
 *  - `?workout=` seeds the workout scope, and yields to `?c=` (an existing
 *    thread) and `?doc=` (the hardened fenced transport, which must never be
 *    diluted by a second scope).
 *
 * The conversation surface is stubbed to a probe that records the props it was
 * handed, so these assert the resolved props rather than rendered text —
 * responsive classes have broken text-based queries in this repo.
 */

const conversationProps = vi.fn();

vi.mock("@/components/insights/coach-panel/coach-conversation", () => ({
  CoachConversation: (props: Record<string, unknown>) => {
    conversationProps(props);
    return <div data-slot="coach-conversation-probe" />;
  },
}));

const searchParams = { current: new URLSearchParams() };
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams.current,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/insights/coach-launch-context", () => ({
  useCoachLaunch: () => ({ askCoach: vi.fn() }),
}));
vi.mock("@/hooks/use-feature-flags", () => ({
  useFeatureFlags: () => ({ coach: true }),
}));
vi.mock("@/hooks/use-disable-coach", () => ({
  useDisableCoach: () => false,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: {}, isLoading: false }),
}));
vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({ inSharedRecord: false }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
}));
vi.mock("@/lib/api/api-fetch", () => ({ apiGet: vi.fn() }));

import CoachPageClient from "../page-client";

function renderWith(query: string): Record<string, unknown> {
  searchParams.current = new URLSearchParams(query);
  renderToStaticMarkup(<CoachPageClient />);
  const calls = conversationProps.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/coach — ?scope= is parsed strictly against the closed union", () => {
  it("seeds a launch scope for a known source", () => {
    expect(renderWith("scope=weight").launchScope).toEqual({
      metric: "weight",
    });
  });

  it("IGNORES an unknown value silently", () => {
    // No throw, no error surface — the page still renders the conversation,
    // simply unscoped. A free-form string must never reach the chat route.
    const props = renderWith("scope=not-a-real-source");
    expect(props.launchScope).toBeNull();
  });

  it("ignores a value shaped like an injection attempt", () => {
    expect(renderWith("scope=__proto__").launchScope).toBeNull();
    expect(
      renderWith("scope=" + encodeURIComponent("bp; DROP")).launchScope,
    ).toBeNull();
  });

  it("ignores an empty value", () => {
    expect(renderWith("scope=").launchScope).toBeNull();
  });
});

describe("/coach — ?workout= seeds the workout scope", () => {
  it("threads the id onto a fresh chat", () => {
    expect(renderWith("workout=w1").initialWorkoutId).toBe("w1");
  });

  it("yields to an explicit thread (?c=)", () => {
    const props = renderWith("c=c1&workout=w1");
    expect(props.initialWorkoutId).toBeNull();
    expect(props.initialConversationId).toBe("c1");
  });

  it("yields to a document-scoped chat (?doc=)", () => {
    // The doc path is the hardened fenced transport; a second scope must
    // never dilute it.
    const props = renderWith("doc=d1&workout=w1");
    expect(props.initialWorkoutId).toBeNull();
    expect(props.initialDocumentId).toBe("d1");
  });

  it("is null when absent", () => {
    expect(renderWith("").initialWorkoutId).toBeNull();
  });

  it("composes with a scope hand-off", () => {
    const props = renderWith("workout=w1&scope=workouts");
    expect(props.initialWorkoutId).toBe("w1");
    expect(props.launchScope).toEqual({ metric: "workouts" });
  });
});
