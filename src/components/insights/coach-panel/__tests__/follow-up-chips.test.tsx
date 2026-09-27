import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { getServerTranslator } from "@/lib/i18n/server-translator";

// The chips' only hook is the translator; with the server one the component
// can be called as a plain function and its handlers exercised.
vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({
    t: (key: string) => getServerTranslator("en").t(key),
  }),
}));

import { CoachFollowUpChips } from "../follow-up-chips";
import type { CoachFollowUp } from "@/lib/ai/coach/types";

function chip(id: string, label: string): CoachFollowUp {
  return {
    id,
    kind: "previous_period",
    labelKey: "coach.followUp.previousPeriod",
    label,
    reuse: false,
    origin: "server",
  };
}

const CHIPS = [
  chip("f1", "Compare with the period before"),
  chip("f2", "Look at Sleep too"),
  chip("f3", "Show as a chart"),
  chip("f4", "A fourth one"),
];

function render(followUps: CoachFollowUp[], disabled = false) {
  const onSelect = vi.fn();
  const tree = CoachFollowUpChips({
    followUps,
    messageId: "m1",
    disabled,
    onSelect,
  });
  return { tree, onSelect, html: tree ? renderToStaticMarkup(tree) : "" };
}

function buttons(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  const own = el.props["data-follow-up-id"] ? [el] : [];
  return [...own, ...buttons(el.props.children as ReactNode)];
}

describe("<CoachFollowUpChips>", () => {
  it("renders at most three outline chips in a labelled group, with the server's label", () => {
    const { html, tree } = render(CHIPS);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Suggested follow-ups"');
    expect(html).toContain(">Look at Sleep too</button>");
    expect(html).not.toContain("A fourth one");
    const rendered = buttons(tree);
    expect(rendered).toHaveLength(3);
    for (const button of rendered) {
      expect(button.props.variant).toBe("outline");
      expect(button.props.className).toContain("min-h-11");
    }
  });

  it("sends the tapped chip with the message that offered it", () => {
    const { tree, onSelect } = render(CHIPS);
    (buttons(tree)[1].props.onClick as () => void)();
    expect(onSelect).toHaveBeenCalledWith(CHIPS[1], "m1");
  });

  it("is hidden while a turn is in flight, and when there is nothing to offer", () => {
    expect(render(CHIPS, true).tree).toBeNull();
    expect(render([]).tree).toBeNull();
  });
});
