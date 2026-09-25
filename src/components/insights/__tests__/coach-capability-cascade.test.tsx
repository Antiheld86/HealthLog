/**
 * Every Coach entry point follows one answer: the `coach` capability on
 * `/api/auth/me`.
 *
 * The launchers used to AND the operator's switch with the person's Hide
 * Coach, each on its own, and none of them knew about a missing provider or
 * a missing consent, so the floating button and the "Ask the Coach" pills
 * stayed on screen and opened a Coach that could only answer with an error.
 * Now each surface paints only while the capability is available, and is
 * gone (no DOM trace, no inert control) for every reason it is not.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachLaunchProvider } from "@/lib/insights/coach-launch-context";
import {
  AI_UNAVAILABLE_REASONS,
  type AiCapabilityKey,
  type AiCapabilityState,
} from "@/lib/ai/capabilities/types";
import {
  AI_AVAILABLE,
  aiUnavailable,
} from "@/__tests__/helpers/ai-capability-fixtures";

const coachState = vi.hoisted(() => ({
  current: null as AiCapabilityState | null,
  asked: [] as string[],
}));
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: (key: AiCapabilityKey) => {
    coachState.asked.push(key);
    return coachState.current;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/insights",
}));

import { AskCoachAction } from "../ask-coach-action";
import { CoachLaunchButton } from "../coach-launch-button";
import { LayoutCoachFab } from "../layout-coach-fab";
import { LayoutCoachMount } from "../layout-coach-mount";

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <CoachLaunchProvider>{node}</CoachLaunchProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

interface Surface {
  name: string;
  mount: () => ReactNode;
  /** What proves it painted; empty for surfaces that SSR to nothing. */
  proof: string;
}

const SURFACES: Surface[] = [
  {
    name: "CoachLaunchButton",
    mount: () => <CoachLaunchButton />,
    proof: 'data-slot="coach-launch-inline"',
  },
  {
    name: "AskCoachAction",
    mount: () => <AskCoachAction question="Why?" />,
    proof: 'data-slot="ask-coach-action"',
  },
  {
    name: "LayoutCoachFab",
    mount: () => <LayoutCoachFab />,
    proof: 'data-slot="coach-fab"',
  },
  // The drawer is lazy (next/dynamic) and SSRs to nothing either way; the
  // capability read is what the test pins for it.
  { name: "LayoutCoachMount", mount: () => <LayoutCoachMount />, proof: "" },
];

beforeEach(() => {
  coachState.current = AI_AVAILABLE;
  coachState.asked = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("Coach entry points follow the coach capability", () => {
  for (const surface of SURFACES) {
    it(`${surface.name} paints while the Coach is available`, () => {
      const html = render(surface.mount());
      if (surface.proof) expect(html).toContain(surface.proof);
      expect(coachState.asked).toContain("coach");
    });

    for (const reason of AI_UNAVAILABLE_REASONS) {
      it(`${surface.name} is gone when the Coach is unavailable (${reason})`, () => {
        coachState.current = aiUnavailable(reason);
        const html = render(surface.mount());
        if (surface.proof) expect(html).not.toContain(surface.proof);
        expect(html).not.toMatch(/data-slot="(coach-|ask-coach)/);
        expect(coachState.asked).toContain("coach");
      });
    }
  }
});
