/**
 * A visit or a dose written from its own form can link or unlink documents,
 * and the document's sheet seeds its replace-set pickers from its cached
 * links. A record write that left the document reads alone kept that seed
 * stale, and the next tap on the sheet deleted the new link. Both record
 * bundles therefore evict the document root, and the document's own link
 * write evicts the record roots (pinned in `document-detail-sheet`).
 */
import { describe, expect, it } from "vitest";

import {
  encounterDependentKeys,
  queryKeys,
  vaccinationDependentKeys,
} from "@/lib/query-keys";

describe("record writes reach the document reads", () => {
  it("a dose write evicts the documents root", () => {
    expect(vaccinationDependentKeys).toContainEqual(queryKeys.documents());
  });

  it("a visit write evicts the documents root", () => {
    expect(encounterDependentKeys).toContainEqual(queryKeys.documents());
  });
});
