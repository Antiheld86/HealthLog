/**
 * One key, one fetch. The visit form's link pickers read labs and illness
 * episodes with their own page size (200 results, 100 episodes), the Labs
 * list and the illness hook with theirs (500, the route's default 50). Under
 * a shared key whichever read landed first served the other, so the picker
 * could offer 50 episodes or the Labs list could render a 200-row page as
 * the whole list. The picker reads carry their own keys, still under the
 * domain roots so a lab or episode write evicts them.
 */
import { describe, expect, it } from "vitest";

import { queryKeys } from "@/lib/query-keys";

const LIST_PARAMS = {
  analyte: undefined,
  panel: undefined,
  from: undefined,
  to: undefined,
  page: 0,
  sortDir: "desc",
} as const;

describe("the link pickers' reads have keys of their own", () => {
  it("labs: differs from the Labs list and sits under the lab root", () => {
    const key = queryKeys.labResultsPicker(200);
    expect(key).not.toEqual(queryKeys.labResultsList(LIST_PARAMS));
    expect(key.slice(0, 1)).toEqual(queryKeys.labResults());
  });

  it("episodes: differs from the illness list and sits under the illness root", () => {
    const key = queryKeys.illnessEpisodesPicker(100);
    expect(key).not.toEqual(queryKeys.illnessEpisodes(true));
    expect(key.slice(0, 1)).toEqual(queryKeys.illness());
  });

  it("a different page size is a different key", () => {
    expect(queryKeys.labResultsPicker(200)).not.toEqual(
      queryKeys.labResultsPicker(500),
    );
  });
});
