/**
 * The overview arrange list marks every section whose module is off as
 * unavailable, through the same surface map the overview renders from, so
 * Settings never offers a toggle for a block that cannot appear.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const modulesRef: { value: Record<string, boolean> } = { value: {} };
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { modules: modulesRef.value },
  }),
}));
const briefingRef: { available: boolean } = { available: true };
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({
    available: briefingRef.available,
    reason: briefingRef.available ? null : "user_disabled",
    onDeviceAllowed: false,
  }),
}));
vi.mock("@/hooks/use-insights-layout", () => ({
  useInsightsLayoutQuery: () => ({
    layout: { sections: [] },
    isLoading: false,
  }),
}));
const seen: { gated: string[] } = { gated: [] };
vi.mock("@/components/insights/insights-edit-mode", () => ({
  InsightsEditMode: ({
    gatedOffSectionIds,
  }: {
    gatedOffSectionIds: ReadonlySet<string>;
  }) => {
    seen.gated = [...gatedOffSectionIds].sort();
    return null;
  },
}));

import { I18nProvider } from "@/lib/i18n/context";
import { InsightsOverviewArrangeSection } from "../insights-overview-arrange-section";

function gatedFor(modules: Record<string, boolean>): string[] {
  modulesRef.value = modules;
  renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <InsightsOverviewArrangeSection />
    </I18nProvider>,
  );
  return seen.gated;
}

describe("<InsightsOverviewArrangeSection> module gate", () => {
  it("offers every section with every module on", () => {
    expect(gatedFor({})).toEqual([]);
  });

  it("marks the breathing, labs and cycle blocks unavailable with their modules off", () => {
    expect(gatedFor({ sleep: false, labs: false, cycle: false })).toEqual([
      "breathing",
      "cycle-summary",
      "labs-changes",
    ]);
  });

  it("marks nothing for AI analysis off", () => {
    expect(gatedFor({ insights: false })).toEqual([]);
  });

  it("marks only the daily briefing when the briefing is unavailable", () => {
    // The period review renders its composed narrative whatever the AI
    // state, so it stays a live row.
    briefingRef.available = false;
    expect(gatedFor({})).toEqual(["daily-briefing"]);
    briefingRef.available = true;
  });
});
