/**
 * A status note is model-written text: the card paints only while the
 * `statusText` capability is available and is gone, never an error or a
 * "connect a provider" hint, for every reason it is not. The score anatomy's
 * assessment is composed from the numbers (`aiAuthored={false}`) and shows
 * whatever the AI state.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import {
  AI_UNAVAILABLE_REASONS,
  type AiCapabilityKey,
  type AiCapabilityState,
} from "@/lib/ai/capabilities/types";
import {
  AI_AVAILABLE,
  aiUnavailable,
} from "@/__tests__/helpers/ai-capability-fixtures";

const capability = vi.hoisted(() => ({
  current: null as AiCapabilityState | null,
  asked: [] as AiCapabilityKey[],
}));
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: (key: AiCapabilityKey) => {
    capability.asked.push(key);
    return capability.current;
  },
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { timezone: "Europe/Berlin" } }),
}));

import { InsightStatusCard } from "../insight-status-card";

const baseProps = {
  title: "Pulse",
  icon: null,
  text: "Your pulse is stable.",
  hasProvider: true,
  updatedAt: null,
};

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

beforeEach(() => {
  capability.current = AI_AVAILABLE;
  capability.asked = [];
});

describe("<InsightStatusCard> — statusText capability", () => {
  it("renders the note while status notes are available", () => {
    const html = render(<InsightStatusCard {...baseProps} />);
    expect(html).toContain("Your pulse is stable");
    expect(capability.asked).toContain("statusText");
  });

  for (const reason of AI_UNAVAILABLE_REASONS) {
    it(`renders nothing when status notes are unavailable (${reason})`, () => {
      capability.current = aiUnavailable(reason);
      expect(render(<InsightStatusCard {...baseProps} />)).toBe("");
    });
  }

  it("never renders a connect-a-provider state", () => {
    const html = render(
      <InsightStatusCard {...baseProps} text={null} hasProvider={false} />,
    );
    expect(html).not.toContain("/settings/ai");
    expect(html).not.toContain("insight-status-no-provider-cta");
  });

  it("keeps a composed assessment visible whatever the AI state", () => {
    capability.current = aiUnavailable("operator_disabled");
    const html = render(
      <InsightStatusCard {...baseProps} aiAuthored={false} />,
    );
    expect(html).toContain("Your pulse is stable");
  });
});
