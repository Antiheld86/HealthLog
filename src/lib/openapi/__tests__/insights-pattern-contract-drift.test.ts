import { describe, expect, it } from "vitest";

import { insightsPaths } from "../routes/insights/paths";

/**
 * Correlation patterns are statistics, not model output. The `insights`
 * module is the AI analysis opt-out, so it no longer gates them, and the
 * contract must not promise a `module.disabled` refusal the routes never
 * send. The 403 that remains is the sharing fence.
 */
describe("insight patterns OpenAPI contract", () => {
  it("documents the sharing refusal and no module refusal for list and dismissal updates", () => {
    const listResponses =
      insightsPaths["/api/insights/patterns"]?.get?.responses;
    const updateResponses =
      insightsPaths["/api/insights/patterns/{id}"]?.patch?.responses;

    for (const responses of [listResponses, updateResponses]) {
      expect(Object.keys(responses ?? {})).toContain("403");
      const description = responses?.["403"]?.description ?? "";
      expect(description).toContain("sharing.access.denied");
      expect(description).not.toContain("module.disabled");
    }
  });
});
