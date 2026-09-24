import { describe, expect, it } from "vitest";

import { illnessEpisodeListQuerySchema } from "@/lib/validations/illness";
import { listLabResultsSchema } from "@/lib/validations/labs";
import {
  EPISODE_FETCH_LIMIT,
  PICKER_FETCH_LIMIT,
} from "../encounter-link-pickers";

/**
 * Each picker's page size must be one its list route accepts. A refused size
 * comes back as a 422, and a picker that treats a failed read as an empty
 * list tells the person there is nothing to link. That is how the visit
 * form's condition picker and both document pickers showed nothing at all.
 */
describe("visit link picker page sizes", () => {
  it("the condition picker asks for a page the episode route accepts", () => {
    expect(
      illnessEpisodeListQuerySchema.safeParse({
        limit: String(EPISODE_FETCH_LIMIT),
        includeResolved: "true",
      }).success,
    ).toBe(true);
  });

  it("the lab picker asks for a page the lab route accepts", () => {
    expect(
      listLabResultsSchema.safeParse({ limit: String(PICKER_FETCH_LIMIT) })
        .success,
    ).toBe(true);
  });
});
