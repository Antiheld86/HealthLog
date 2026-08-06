import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MANAGED_RECORD_SETTINGS_FIELD_ALLOWLIST } from "@/lib/record-settings";

const fromRoot = (...segments: string[]) => resolve(process.cwd(), ...segments);

const RECORD_SETTINGS_ROUTE_ROOT = fromRoot("src/app/api/record-settings");

describe("record settings route guard", () => {
  it("freezes the non-empty guardian-only route inventory", async () => {
    const discovered = (
      await readdir(RECORD_SETTINGS_ROUTE_ROOT, {
        recursive: true,
      })
    )
      .filter((entry) => entry.endsWith("route.ts"))
      .map((entry) => `app/api/record-settings/${entry}`)
      .sort();

    expect(discovered).toHaveLength(3);
    expect(discovered).toEqual([
      "app/api/record-settings/[family]/route.ts",
      "app/api/record-settings/integrations/route.ts",
      "app/api/record-settings/route.ts",
    ]);
  });

  it("resolves every record-settings route through the Guardian fence", async () => {
    const routes = [
      "route.ts",
      "integrations/route.ts",
      "[family]/route.ts",
    ] as const;
    const sources = await Promise.all(
      routes.map((route) =>
        readFile(resolve(RECORD_SETTINGS_ROUTE_ROOT, route), "utf8"),
      ),
    );

    for (const source of sources) {
      expect(source).toContain("requireGuardianAuth");
      expect(source).toContain("resolveGuardianRecordSettingsAccess");
    }
  });

  it("makes the field-specific route exhaustive over the approved DTO families", async () => {
    const source = await readFile(
      resolve(RECORD_SETTINGS_ROUTE_ROOT, "[family]/route.ts"),
      "utf8",
    );

    const families = Object.keys(MANAGED_RECORD_SETTINGS_FIELD_ALLOWLIST);
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) {
      expect(source).toContain(`case \"${family}\"`);
    }
  });
});
