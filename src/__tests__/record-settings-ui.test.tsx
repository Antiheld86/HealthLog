import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const fromRoot = (...segments: string[]) => resolve(process.cwd(), ...segments);

describe("managed record settings UI", () => {
  it("renders integration status without connection controls", async () => {
    const [statusView, settingsPage] = await Promise.all([
      readFile(
        fromRoot("src/components/settings/managed-integration-status.tsx"),
        "utf8",
      ),
      readFile(fromRoot("src/app/settings/[section]/page.tsx"), "utf8"),
    ]);

    expect(statusView).toContain("recordSettingsIntegrations");
    expect(statusView).toContain("/api/record-settings/integrations");
    expect(statusView).not.toContain("<Button");
    expect(statusView).not.toContain("<Link");
    expect(settingsPage).toContain("RecordSettingsSectionGate");
  });
});
