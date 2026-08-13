import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * #781 — the persisted cancelled-turn marker (an EMPTY assistant row with
 * `providerType: "cancelled"`) renders as a quiet interrupted note with a
 * retry, never as an empty assistant bubble. SSR harness mirrors
 * `chat-bubble-unverified-notice.test.tsx`.
 */
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "tester", role: "USER", avatarUrl: null },
    isAuthenticated: true,
    isLoading: false,
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

import { MessageThread } from "../message-thread";
import type {
  CoachConversationDetailDTO,
  CoachMessageDTO,
} from "@/lib/ai/coach/types";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function conversationWith(
  messages: Array<Partial<CoachMessageDTO>>,
): CoachConversationDetailDTO {
  return {
    id: "c1",
    title: "Test",
    createdAt: "2026-08-13T10:00:00.000Z",
    updatedAt: "2026-08-13T10:00:00.000Z",
    messageCount: messages.length,
    fenced: false,
    attachments: [],
    attachmentCount: 0,
    documentTitle: null,
    messages: messages.map((m, i) => ({
      id: `m${i}`,
      role: "user",
      content: "",
      createdAt: "2026-08-13T10:00:00.000Z",
      metricSource: null,
      providerType: null,
      promptVersion: null,
      tokensUsed: null,
      model: null,
      ...m,
    })),
  };
}

const interruptedThread = conversationWith([
  { role: "user", content: "How is my blood pressure trending?" },
  { role: "assistant", content: "", providerType: "cancelled" },
]);

describe("chat bubble — cancelled-turn marker (#781)", () => {
  it("renders the interrupted note with a retry action, muted, no alarm colour", () => {
    const html = render(
      <MessageThread
        conversation={interruptedThread}
        onRegenerate={() => undefined}
      />,
    );
    expect(html).toContain('data-slot="coach-bubble-cancelled"');
    expect(html).toContain("This answer was interrupted before it finished.");
    // The retry resubmits the preceding user question — the thread resolved
    // one, so the affordance is present.
    expect(html).toContain('data-slot="coach-interrupted-retry"');
    expect(html).toContain("Ask again");
    // Muted meta, not an alarm: the marker must not paint destructive/warning.
    const markerHtml = html.slice(html.indexOf("coach-bubble-cancelled"));
    expect(markerHtml).not.toContain("text-destructive");
    expect(markerHtml).not.toContain("text-warning");
    // No empty assistant prose bubble alongside the marker.
    expect(html).not.toContain('data-slot="coach-bubble-assistant"');
  });

  it("omits the retry when the surface supplies no regenerate handler", () => {
    const html = render(<MessageThread conversation={interruptedThread} />);
    expect(html).toContain('data-slot="coach-bubble-cancelled"');
    expect(html).not.toContain('data-slot="coach-interrupted-retry"');
  });
});
