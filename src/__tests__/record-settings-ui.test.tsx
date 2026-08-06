import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const fromRoot = (...segments: string[]) => resolve(process.cwd(), ...segments);

describe("managed record settings UI", () => {
  it("gates shared deep links and renders integration status without controls", async () => {
    const [statusView, settingsPage, sectionGate, ...localeBundles] =
      await Promise.all([
        readFile(
          fromRoot("src/components/settings/managed-integration-status.tsx"),
          "utf8",
        ),
        readFile(fromRoot("src/app/settings/[section]/page.tsx"), "utf8"),
        readFile(
          fromRoot("src/components/settings/record-settings-section-gate.tsx"),
          "utf8",
        ),
        ...["de", "en", "es", "fr", "it", "pl"].map((locale) =>
          readFile(fromRoot(`messages/${locale}.json`), "utf8"),
        ),
      ]);

    expect(statusView).toContain("recordSettingsIntegrations");
    expect(statusView).toContain("/api/record-settings/integrations");
    expect(statusView).not.toContain("<Button");
    expect(statusView).not.toContain("<Link");
    expect(settingsPage).toContain("RecordSettingsSectionGate");
    expect(sectionGate).toContain("if (!inSharedRecord) return children");
    expect(sectionGate).toContain("ManagedIntegrationStatus");
    for (const bundle of localeBundles) {
      expect(bundle).toContain('"sharedRecord"');
      expect(bundle).toContain('"unavailableTitle"');
      expect(bundle).toContain('"integrationStatusDescription"');
    }
  });
});
