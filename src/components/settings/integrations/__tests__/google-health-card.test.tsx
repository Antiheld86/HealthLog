import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(
    process.cwd(),
    "src/components/settings/integrations/google-health-card.tsx",
  ),
  "utf8",
);

describe("GoogleHealthCard manual-sync terminal contract", () => {
  it("polls the authenticated status route when POST completion is uncertain", () => {
    expect(source).toContain('"/api/google-health/sync/status"');
    expect(source).toMatch(
      /catch[\s\S]{0,1200}(poll|status)|timeout[\s\S]{0,1200}(poll|status)/i,
    );
    expect(source).toMatch(/complete/);
    expect(source).toMatch(/partial/);
    expect(source).toMatch(/failed/);
    expect(source).toMatch(/interrupted/);
  });

  it("invalidates every affected client query after a committed workout outcome", () => {
    expect(source).toContain(
      "queryClient.invalidateQueries({ queryKey: queryKeys.workouts() })",
    );
    expect(source).toContain(
      "queryClient.invalidateQueries({ queryKey: queryKeys.dashboardSnapshot() })",
    );
    expect(source).toContain(
      "queryClient.invalidateQueries({ queryKey: queryKeys.analytics() })",
    );
    expect(source).toContain(
      "queryClient.invalidateQueries({ queryKey: queryKeys.googleHealth() })",
    );
    expect(source).toContain("queryKey: queryKeys.integrationsStatus()");
    expect(source).toMatch(
      /resource\s*===?\s*["']workout["'][\s\S]{0,500}written\s*>\s*0|written\s*>\s*0[\s\S]{0,500}resource\s*===?\s*["']workout["']/,
    );
  });

  it("does not send a caller-selected owner or use ad-hoc query-key arrays", () => {
    expect(source).not.toMatch(
      /sync\/status[^"']*(?:userId|ownerId)|body:\s*JSON\.stringify\(\{[^}]*userId/,
    );
    expect(source).not.toMatch(
      /invalidateQueries\(\s*\{\s*queryKey:\s*\[[^\]]+\]/,
    );
  });
});
