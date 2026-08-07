import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

const authRef: {
  isLoading: boolean;
  active: {
    accountId: string;
    recordKind: "managed" | "shared";
    level: "manage" | "write" | "read";
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
vi.mock("../record-anamnesis-section", () => ({
  RecordAnamnesisSection: () => <div data-slot="record-anamnesis" />,
}));

import { RecordSettingsSectionGate } from "../record-settings-section-gate";

function render(section: "modules" | "integrations" | "anamnesis" | "labs") {
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

  /**
   * The record-content destination, and the two ways it must not open.
   *
   * The branch keys on the SLUG as well as on the classification. Keying on
   * the kind alone would render the allergy and family-history managers under
   * the heading of any future `manage-writable` destination — silently,
   * because a category matched where a page was meant.
   */
  describe("the anamnesis destination", () => {
    it("opens for an adult manager on an ordinary shared record", () => {
      authRef.isLoading = false;
      authRef.active = {
        accountId: "shared-record",
        recordKind: "shared",
        level: "manage",
        sections: null,
        canWrite: true,
      };

      const html = render("anamnesis");

      expect(html).toContain("record-anamnesis");
      expect(html).not.toContain("actor-settings");
      expect(html).not.toContain("managed-settings");
    });

    it("opens for a Guardian, rather than the guardian configuration panel", () => {
      authRef.isLoading = false;
      authRef.active = {
        accountId: "managed-record",
        recordKind: "managed",
        level: "manage",
        sections: null,
        canWrite: true,
      };

      const html = render("anamnesis");

      expect(html).toContain("record-anamnesis");
      expect(html).not.toContain("managed-settings");
    });

    it("stays shut below MANAGE", () => {
      authRef.isLoading = false;
      authRef.active = {
        accountId: "shared-record",
        recordKind: "shared",
        level: "write",
        sections: null,
        canWrite: true,
      };

      const html = render("anamnesis");

      expect(html).not.toContain("record-anamnesis");
      expect(html).toContain("shared-record-settings-unavailable-title");
    });

    it("does not lend its page to another destination of the same kind", () => {
      // `labs` is `adult-shared-unavailable` today, so this passes for the
      // right reason now; the claim it pins is that the branch asks WHICH
      // page, not which category. A second `manage-writable` slug added
      // without an arm falls through to the refusal panel.
      authRef.isLoading = false;
      authRef.active = {
        accountId: "shared-record",
        recordKind: "shared",
        level: "manage",
        sections: null,
        canWrite: true,
      };

      const html = render("labs");

      expect(html).not.toContain("record-anamnesis");
      expect(html).toContain("shared-record-settings-unavailable-title");
    });
  });
});
