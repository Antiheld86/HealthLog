import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { classifySettingsDestination } from "@/lib/record-settings";

const pathnameRef = { value: "/settings/security" };
const activeRecordRef = { value: true };

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.value,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: activeRecordRef.value
      ? {
          id: "guardian",
          modules: undefined,
          accountAccess: {
            active: {
              accountId: "managed-record",
              username: "managed-record",
              displayName: "Managed record",
              access: "write",
              level: "manage",
              recordKind: "managed",
              sections: null,
              canWrite: true,
            },
            accounts: [],
            canSwitch: true,
          },
        }
      : null,
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-account-switch", () => ({
  useAccountSwitch: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

import {
  SETTINGS_SECTIONS,
  SettingsShell,
} from "@/components/settings/settings-shell";
import { SharedRecordBanner } from "@/components/layout/shared-record-banner";

function renderSettings(pathname = "/settings/security") {
  pathnameRef.value = pathname;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SettingsShell>
        <div>managed settings content</div>
      </SettingsShell>
    </I18nProvider>,
  );
}

describe("managed record navigation", () => {
  it("shows only managed settings destinations while retaining an unavailable deep-link heading", () => {
    const html = renderSettings();
    const managedDestinations = SETTINGS_SECTIONS.filter(
      (section) =>
        classifySettingsDestination(section.slug).kind === "managed-guardian",
    );
    const unavailableDestinations = SETTINGS_SECTIONS.filter(
      (section) =>
        classifySettingsDestination(section.slug).kind !== "managed-guardian",
    );

    expect(html).toContain('data-active-record-id="managed-record"');
    expect(html).toContain('id="settings-section-security-title"');
    expect(html).not.toMatch(/href="[^"]*managed-record/);

    for (const section of managedDestinations) {
      expect(
        html.match(new RegExp(`href="/settings/${section.slug}"`, "g"))
          ?.length ?? 0,
      ).toBe(2);
    }

    for (const section of unavailableDestinations) {
      expect(html).not.toContain(`href="/settings/${section.slug}"`);
    }
  });

  it("keeps the exit control present while administering a managed record", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <SharedRecordBanner />
      </I18nProvider>,
    );

    expect(html).toContain('data-account-id="managed-record"');
    expect(html).toContain('data-slot="shared-record-banner-exit"');
  });
});
