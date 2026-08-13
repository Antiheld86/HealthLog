import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { CoachPlanDTO } from "@/hooks/use-coach-plans";
import {
  PlanProposalCards,
  PROPOSAL_POLL_MS,
  PROPOSAL_POLL_MAX_ATTEMPTS,
  nextProposalPollInterval,
} from "../plan-proposal-card";

/**
 * The plan-proposal confirm cards at the thread tail. SSR string render
 * against a pre-seeded query cache (the `status:proposed` slot the component
 * reads), so the tests pin the render contract without a network layer:
 * only proposals born in the OPEN conversation render, the prose reads in
 * the card, and both actions are present as real buttons.
 */

function plan(overrides: Partial<CoachPlanDTO> = {}): CoachPlanDTO {
  return {
    id: "p1",
    metric: "WEIGHT",
    ifCue: "every morning",
    thenAction: "weigh in before breakfast",
    target: "steady trend by autumn",
    status: "proposed",
    reviewDate: null,
    sourceConversationId: "conv-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function render(conversationId: string, plans: CoachPlanDTO[]) {
  const client = new QueryClient();
  client.setQueryData(queryKeys.coachPlans("status:proposed"), plans);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <PlanProposalCards conversationId={conversationId} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<PlanProposalCards>", () => {
  it("renders nothing when the conversation has no open proposal", () => {
    expect(render("conv-1", [])).toBe("");
  });

  it("renders a confirm card for a proposal born in the open conversation", () => {
    const html = render("conv-1", [plan()]);
    expect(html).toContain('data-slot="coach-plan-proposal-card"');
    // The plan prose is content — visible in the card.
    expect(html).toContain("every morning");
    expect(html).toContain("weigh in before breakfast");
    expect(html).toContain("steady trend by autumn");
    expect(html).toContain("WEIGHT");
    // Both actions render as real buttons.
    expect(html).toContain('data-slot="coach-plan-proposal-accept"');
    expect(html).toContain('data-slot="coach-plan-proposal-decline"');
  });

  it("hides proposals born in a different conversation", () => {
    const html = render("conv-2", [plan()]);
    expect(html).toBe("");
  });

  it("skips a proposal whose prose is undecryptable (null fields)", () => {
    const html = render("conv-1", [plan({ ifCue: null, thenAction: null })]);
    expect(html).toBe("");
  });

  it("renders one card per open proposal", () => {
    const html = render("conv-1", [
      plan(),
      plan({ id: "p2", ifCue: "after dinner", thenAction: "short walk" }),
    ]);
    expect(html.match(/coach-plan-proposal-card/g)?.length).toBe(2);
    expect(html).toContain("after dinner");
  });
});

describe("nextProposalPollInterval", () => {
  it("polls at the slow interval below the attempt ceiling", () => {
    expect(nextProposalPollInterval(0)).toBe(PROPOSAL_POLL_MS);
    expect(nextProposalPollInterval(PROPOSAL_POLL_MAX_ATTEMPTS - 1)).toBe(
      PROPOSAL_POLL_MS,
    );
  });

  it("stops polling once the attempt ceiling is reached", () => {
    // Watched red: asserting an interval at the cap fails — the ceiling is
    // live, not decorative.
    expect(nextProposalPollInterval(PROPOSAL_POLL_MAX_ATTEMPTS)).toBe(false);
    expect(nextProposalPollInterval(PROPOSAL_POLL_MAX_ATTEMPTS + 5)).toBe(
      false,
    );
  });
});
