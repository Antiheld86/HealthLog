import { describe, expect, it } from "vitest";

import { insightsPaths } from "../routes/insights/paths";

describe("insight patterns module gate OpenAPI contract", () => {
  it("documents module.disabled for list and dismissal updates", () => {
    const listResponses =
      insightsPaths["/api/insights/patterns"]?.get?.responses;
    const updateResponses =
      insightsPaths["/api/insights/patterns/{id}"]?.patch?.responses;

    for (const responses of [listResponses, updateResponses]) {
      expect(Object.keys(responses ?? {})).toContain("403");
      expect(responses?.["403"]?.description).toContain("module.disabled");
    }
  });
});
