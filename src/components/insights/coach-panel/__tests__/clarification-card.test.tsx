import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { getServerTranslator } from "@/lib/i18n/server-translator";

// The card's only hook is the translator; the server one resolves the same
// bundles and returns the key for a missing string, like the client one. With
// it, the card can be called as a plain function and its handlers exercised
// (the node test environment has no DOM to click through).
vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({
    t: (key: string) => getServerTranslator("en").t(key),
  }),
}));

import { CoachClarificationCard } from "../clarification-card";
import type { CoachClarification } from "@/lib/ai/coach/types";

const METRIC: CoachClarification = {
  kind: "metric",
  choices: [
    {
      id: "c1",
      labelKey: "insights.coach.metric.pulse",
      label: "Pulse (server)",
      value: { metric: "pulse" },
    },
    {
      id: "c2",
      labelKey: "coach.not.a.key",
      label: "Server label",
      value: { metric: "resting_hr" },
    },
  ],
  freeText: true,
};

function card(clarification: CoachClarification, disabled = false) {
  const onChoose = vi.fn();
  const tree = CoachClarificationCard({
    clarification,
    messageId: "m1",
    disabled,
    onChoose,
  });
  return { tree, onChoose, html: renderToStaticMarkup(tree) };
}

function choiceButtons(
  node: ReactNode,
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(choiceButtons);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  const own = el.props["data-choice-id"] ? [el] : [];
  return [...own, ...choiceButtons(el.props.children as ReactNode)];
}

describe("<CoachClarificationCard>", () => {
  it("announces politely and takes no focus", () => {
    const { html } = card(METRIC);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="The Coach has a question"');
    expect(html).not.toContain("autofocus");
    expect(html).not.toContain("autoFocus");
  });

  it("renders the catalog label, falling back to the server label", () => {
    const { html } = card(METRIC);
    expect(html).toContain('aria-label="Possible answers"');
    expect(html).toContain(">Pulse</button>");
    expect(html).toContain(">Server label</button>");
    expect(html).toContain("You can also type your own answer.");
  });

  it("sends the tapped choice", () => {
    const { tree, onChoose } = card(METRIC);
    const buttons = choiceButtons(tree);
    expect(buttons).toHaveLength(2);
    (buttons[1].props.onClick as () => void)();
    expect(onChoose).toHaveBeenCalledWith(METRIC.choices[1]);
  });

  it("disables the choices while a turn is in flight", () => {
    const { tree } = card(METRIC, true);
    for (const button of choiceButtons(tree)) {
      expect(button.props.disabled).toBe(true);
    }
  });

  it("asks for a typed answer on a context question", () => {
    const { html, tree } = card({
      kind: "context",
      choices: [],
      freeText: true,
    });
    expect(choiceButtons(tree)).toHaveLength(0);
    expect(html).not.toContain('role="group"');
    expect(html).toContain("Type your answer below.");
  });
});
