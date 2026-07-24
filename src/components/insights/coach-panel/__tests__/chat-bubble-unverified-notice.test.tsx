import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// v1.32.14 — the per-message "some figures couldn't be checked" notice renders
// only on a settled assistant turn whose provenance carries unverifiedFigures ≥ 1.
// Mirror the coach-charts harness: SSR render with the hooks the bubble reaches
// for stubbed out.
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
  CoachProvenance,
} from "@/lib/ai/coach/types";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

// Distinctive substrings free of HTML-escaped characters, so the assertion does
// not couple to how the SSR renderer escapes the apostrophe in "couldn't".
const EN_COPY_HEAD = "be checked against your data and were left out.";

function conversationWith(
  overrides: Partial<CoachMessageDTO>,
): CoachConversationDetailDTO {
  const message: CoachMessageDTO = {
    id: "m1",
    role: "assistant",
    content: "Your systolic was […] mmHg last week.",
    createdAt: "2026-07-24T10:00:00.000Z",
    metricSource: null,
    providerType: "openai",
    promptVersion: null,
    tokensUsed: null,
    model: null,
    ...overrides,
  };
  return {
    id: "c1",
    title: "Test",
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
    messageCount: 1,
    fenced: false,
    attachmentCount: 0,
    messages: [message],
  };
}

describe("Coach unverified-figures notice", () => {
  it("renders under a settled assistant turn when unverifiedFigures ≥ 1", () => {
    const provenance: CoachProvenance = {
      windows: [],
      metrics: [],
      unverifiedFigures: 1,
    };
    const html = render(
      <MessageThread
        conversation={conversationWith({ metricSource: provenance })}
      />,
    );
    expect(html).toContain('data-slot="coach-unverified-notice"');
    // Muted meta treatment (UI-STANDARDS §3) — never a warning colour.
    expect(html).toContain("text-muted-foreground");
  });

  it("carries the localized, count-free copy", () => {
    const html = render(
      <MessageThread
        conversation={conversationWith({
          metricSource: { windows: [], metrics: [], unverifiedFigures: 3 },
        })}
      />,
    );
    // Count-free sentence works for any n even though unverifiedFigures is 3.
    expect(html).toContain(EN_COPY_HEAD);
    expect(EN_COPY_HEAD).not.toMatch(/\d/);
  });

  it("does NOT render when no figure was withheld", () => {
    const html = render(
      <MessageThread
        conversation={conversationWith({
          metricSource: { windows: ["last7days"], metrics: ["bp"] },
        })}
      />,
    );
    expect(html).not.toContain('data-slot="coach-unverified-notice"');
  });

  it("does NOT render when provenance is absent", () => {
    const html = render(
      <MessageThread conversation={conversationWith({ metricSource: null })} />,
    );
    expect(html).not.toContain('data-slot="coach-unverified-notice"');
  });

  it("does NOT render on a refusal turn even with the field set", () => {
    const html = render(
      <MessageThread
        conversation={conversationWith({
          providerType: "refusal",
          metricSource: { windows: [], metrics: [], unverifiedFigures: 1 },
        })}
      />,
    );
    expect(html).not.toContain('data-slot="coach-unverified-notice"');
  });
});
