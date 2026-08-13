import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * #781 — returning to `/coach` after a navigation aborted a streaming reply
 * must land the user back IN the interrupted conversation, not on a blank
 * new chat. The unmount cleanup in `use-coach.ts` records the interrupted
 * conversation under `COACH_INTERRUPTED_STORAGE_KEY`; this pins the page's
 * consumption side:
 *
 *  - a stored conversation id seeds `initialConversationId` (same prop the
 *    `?c=` deep-link drives);
 *  - the `"latest"` sentinel (a first-turn abort whose id never reached the
 *    client) flips `autoOpenMostRecent` instead;
 *  - every EXPLICIT entry intent (`?c=`, `?c=new`, `?doc=`, `?ask=`) wins
 *    over the resume.
 *
 * Same probe pattern as `page-launch-params.test.tsx`: the conversation
 * surface is stubbed and the resolved props are asserted.
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
import { COACH_INTERRUPTED_STORAGE_KEY } from "@/components/insights/coach-panel/use-coach";

// The vitest environment is `node` (SSR-only tests) — there is no `window`.
// The page reads the flag through `window.sessionStorage` behind a
// `typeof window` guard, so stub the minimal surface it touches.
const store = new Map<string, string>();
vi.stubGlobal("window", {
  sessionStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

function renderWith(query: string): Record<string, unknown> {
  searchParams.current = new URLSearchParams(query);
  renderToStaticMarkup(<CoachPageClient />);
  const calls = conversationProps.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
});

describe("/coach — interrupted-conversation resume (#781)", () => {
  it("reopens the interrupted conversation recorded by the aborted stream", () => {
    store.set(COACH_INTERRUPTED_STORAGE_KEY, "conv-42");
    const props = renderWith("");
    expect(props.initialConversationId).toBe("conv-42");
  });

  it("resolves a first-turn abort (sentinel 'latest') via most-recent", () => {
    store.set(COACH_INTERRUPTED_STORAGE_KEY, "latest");
    const props = renderWith("");
    expect(props.initialConversationId).toBe(null);
    expect(props.autoOpenMostRecent).toBe(true);
  });

  it("without a recorded interruption the default new-chat hero stands", () => {
    const props = renderWith("");
    expect(props.initialConversationId).toBe(null);
    expect(props.autoOpenMostRecent).toBe(false);
  });

  it("an explicit ?c= deep-link wins over the resume", () => {
    store.set(COACH_INTERRUPTED_STORAGE_KEY, "conv-42");
    const props = renderWith("c=conv-7");
    expect(props.initialConversationId).toBe("conv-7");
  });

  it("an explicit ?c=new (fresh chat) wins over the resume", () => {
    store.set(COACH_INTERRUPTED_STORAGE_KEY, "conv-42");
    const props = renderWith("c=new");
    expect(props.initialConversationId).toBe(null);
    expect(props.autoOpenMostRecent).toBe(false);
  });

  it("an explicit ?ask= hand-off wins over the resume", () => {
    store.set(COACH_INTERRUPTED_STORAGE_KEY, "conv-42");
    const props = renderWith("ask=How%20did%20I%20sleep");
    expect(props.initialConversationId).toBe(null);
  });

  it("a ?doc= scoped chat wins over the resume", () => {
    store.set(COACH_INTERRUPTED_STORAGE_KEY, "conv-42");
    const props = renderWith("doc=doc-1");
    expect(props.initialConversationId).toBe(null);
    expect(props.initialDocumentId).toBe("doc-1");
  });
});
