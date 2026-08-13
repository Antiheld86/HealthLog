import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { AnamnesisSection } from "../anamnesis-section";

const moduleState = vi.hoisted(() => ({
  coach: true,
  insights: true,
}));

vi.mock("@/hooks/use-module-enabled", () => ({
  useModuleEnabled: (key: "coach" | "insights") => moduleState[key],
}));
vi.mock("@/components/records/ai-profile-inclusion-manager", () => ({
  AiProfileInclusionManager: () => <div data-slot="ai-inclusion" />,
}));
vi.mock("@/components/records/conditions-manager", () => ({
  ConditionsManager: () => <div data-slot="conditions" />,
}));
vi.mock("@/components/records/health-profile-facts-manager", () => ({
  HealthProfileFactsManager: () => null,
}));
vi.mock("@/components/records/allergy-manager", () => ({
  AllergyManager: () => null,
}));
vi.mock("@/components/records/allergy-free-text-note", () => ({
  AllergyFreeTextNote: () => null,
}));
vi.mock("@/components/records/about-me-note-manager", () => ({
  AboutMeNoteManager: () => <div data-slot="about-me-note" />,
}));
vi.mock("@/components/records/family-history-manager", () => ({
  FamilyHistoryManager: () => null,
}));
vi.mock("@/components/records/emergency-profile-manager", () => ({
  EmergencyProfileManager: () => null,
}));

function renderSection(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <AnamnesisSection />
    </I18nProvider>,
  );
}

beforeEach(() => {
  moduleState.coach = true;
  moduleState.insights = true;
});

describe("Anamnesis AI inclusion availability", () => {
  it("keeps inclusion controls available to Insights-only users", () => {
    moduleState.coach = false;

    const html = renderSection();

    expect(html).toContain('data-slot="ai-inclusion"');
    expect(html).not.toContain('data-slot="conditions"');
  });

  it("hides inclusion controls when no self-context AI consumer is enabled", () => {
    moduleState.coach = false;
    moduleState.insights = false;

    expect(renderSection()).not.toContain('data-slot="ai-inclusion"');
  });

  it("retains the Coach-only conditions manager gate", () => {
    moduleState.insights = false;

    const html = renderSection();

    expect(html).toContain('data-slot="ai-inclusion"');
    expect(html).toContain('data-slot="conditions"');
  });
});
