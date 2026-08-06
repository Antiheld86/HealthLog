import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

const authRef: {
  isLoading: boolean;
  active: {
    accountId: string;
    recordKind: "managed" | "shared";
    level: "manage";
    sections: null;
    canWrite: true;
  } | null;
} = {
  isLoading: true,
  active: null,
};

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isLoading: authRef.isLoading,
    user: authRef.active
      ? {
          accountAccess: {
            active: authRef.active,
            accounts: [authRef.active],
            canSwitch: true,
          },
        }
      : null,
  }),
}));

vi.mock("../managed-record-settings-section", () => ({
  ManagedRecordSettingsSection: () => <div data-slot="managed-settings" />,
}));
vi.mock("../managed-integration-status", () => ({
  ManagedIntegrationStatus: () => <div data-slot="managed-integrations" />,
}));

import { RecordSettingsSectionGate } from "../record-settings-section-gate";

function render(section: "modules" | "integrations") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <RecordSettingsSectionGate section={section}>
        <div data-slot="actor-settings" />
      </RecordSettingsSectionGate>
    </I18nProvider>,
  );
}

describe("RecordSettingsSectionGate", () => {
  it("does not mount an actor Settings component while auth is unresolved", () => {
    authRef.isLoading = true;
    authRef.active = null;

    const html = render("modules");

    expect(html).not.toContain("actor-settings");
    expect(html).toContain('role="status"');
  });

  it("uses the record-scoped section under a switched Guardian", () => {
    authRef.isLoading = false;
    authRef.active = {
      accountId: "managed-record",
      recordKind: "managed",
      level: "manage",
      sections: null,
      canWrite: true,
    };

    const html = render("modules");

    expect(html).toContain("managed-settings");
    expect(html).not.toContain("actor-settings");
  });
});
