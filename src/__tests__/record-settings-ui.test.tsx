import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const fromRoot = (...segments: string[]) => resolve(process.cwd(), ...segments);

function expectMatchingMessageKeys(expected: unknown, actual: unknown): void {
  if (
    expected === null ||
    typeof expected !== "object" ||
    actual === null ||
    typeof actual !== "object"
  ) {
    expect(typeof actual).toBe(typeof expected);
    return;
  }

  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  expect(Object.keys(actualRecord).sort()).toEqual(
    Object.keys(expectedRecord).sort(),
  );
  for (const key of Object.keys(expectedRecord)) {
    expectMatchingMessageKeys(expectedRecord[key], actualRecord[key]);
  }
}

describe("managed record settings UI", () => {
  it("gates shared deep links and renders integration status without controls", async () => {
    const [
      statusView,
      managedSettingsView,
      settingsPage,
      layoutModulePage,
      sectionGate,
      ...localeBundles
    ] = await Promise.all([
      readFile(
        fromRoot("src/components/settings/managed-integration-status.tsx"),
        "utf8",
      ),
      readFile(
        fromRoot("src/components/settings/managed-record-settings-section.tsx"),
        "utf8",
      ),
      readFile(fromRoot("src/app/settings/[section]/page.tsx"), "utf8"),
      readFile(fromRoot("src/app/settings/layout/[module]/page.tsx"), "utf8"),
      readFile(
        fromRoot("src/components/settings/record-settings-section-gate.tsx"),
        "utf8",
      ),
      ...["de", "en", "es", "fr", "it", "pl", "ko"].map((locale) =>
        readFile(fromRoot(`messages/${locale}.json`), "utf8"),
      ),
    ]);

    expect(statusView).toContain("recordSettingsIntegrations");
    expect(statusView).toContain("/api/record-settings/integrations");
    expect(statusView).toContain("assertRecordSettingsResponseForRecord");
    expect(statusView).not.toContain("<Button");
    expect(statusView).not.toContain("<Link");
    expect(settingsPage).toContain("RecordSettingsSectionGate");
    expect(sectionGate).toContain("if (!inSharedRecord) return children");
    expect(sectionGate).toContain("ManagedIntegrationStatus");
    expect(sectionGate).toContain("ManagedRecordSettingsSection");
    expect(sectionGate).toContain("if (isLoading)");
    expect(layoutModulePage).toContain(
      'RecordSettingsSectionGate section="layout"',
    );
    expect(managedSettingsView).toContain(
      "safeParseManagedRecordSettingsPatch",
    );
    expect(managedSettingsView).toContain("/api/record-settings/${family}");
    expect(managedSettingsView).not.toContain("/api/auth/");
    expect(managedSettingsView).not.toContain("/api/user/");
    expect(managedSettingsView).not.toContain("<textarea");
    expect(managedSettingsView).not.toContain("Display name");
    expect(managedSettingsView).not.toContain("Enable mood reminder");
    const referenceMessages = JSON.parse(localeBundles[0]).settings.sharedRecord
      .managedSettings;
    for (const bundle of localeBundles) {
      const sharedRecord = JSON.parse(bundle).settings.sharedRecord;
      expect(sharedRecord).toMatchObject({
        unavailableTitle: expect.any(String),
        integrationStatusDescription: expect.any(String),
        managedSettings: {
          profile: {
            title: expect.any(String),
            displayName: expect.any(String),
          },
          modules: { title: expect.any(String) },
          notifications: { title: expect.any(String) },
          thresholds: { title: expect.any(String) },
          coach: { title: expect.any(String) },
          insights: { title: expect.any(String) },
        },
      });
      expectMatchingMessageKeys(
        referenceMessages,
        sharedRecord.managedSettings,
      );
    }
  });
});
