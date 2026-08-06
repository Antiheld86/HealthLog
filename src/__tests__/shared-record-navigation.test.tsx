import { describe, expect, it } from "vitest";

import {
  SHARED_RECORD_DOMAIN_ROUTE_FAMILIES,
  resolveSharedRecordNavigation,
} from "@/lib/navigation/shared-record";
import { SHARE_DOMAINS } from "@/lib/sharing/scope";
import {
  isDestinationInSharedRecord,
  visibleNavDestinations,
} from "@/components/layout/nav-model";

describe("shared-record navigation", () => {
  it("keeps every granted route family in one closed eight-domain inventory", () => {
    expect(Object.keys(SHARED_RECORD_DOMAIN_ROUTE_FAMILIES)).toEqual(
      SHARE_DOMAINS,
    );

    for (const domain of SHARE_DOMAINS) {
      expect(
        SHARED_RECORD_DOMAIN_ROUTE_FAMILIES[domain].length,
        `${domain} needs at least one route family`,
      ).toBeGreaterThan(0);
    }
  });

  it("offers a scoped grant only its matching doorway", () => {
    const navigation = resolveSharedRecordNavigation(["labs"]);

    expect(navigation.destinationHrefs).toEqual(["/labs"]);
    expect(navigation.allowsPath("/labs/panel/7")).toBe(true);
    expect(navigation.allowsPath("/medications")).toBe(false);

    expect(
      visibleNavDestinations(undefined, true, true, ["labs"]).map(
        (destination) => destination.href,
      ),
    ).toEqual(["/labs"]);
    expect(isDestinationInSharedRecord("/labs/panel/7", ["labs"])).toBe(true);
    expect(isDestinationInSharedRecord("/medications", ["labs"])).toBe(false);
  });

  it("keeps whole-record navigation distinct from an all-sections scope", () => {
    const wholeRecord = resolveSharedRecordNavigation(null);
    const allSections = resolveSharedRecordNavigation([...SHARE_DOMAINS]);

    expect(wholeRecord.allowsPath("/")).toBe(true);
    expect(allSections.allowsPath("/")).toBe(false);
  });

  it("refuses unclassified direct URLs in presentation before pages start reads", () => {
    const navigation = resolveSharedRecordNavigation(["documents"]);

    expect(navigation.allowsPath("/documents/record-1")).toBe(true);
    expect(navigation.allowsPath("/settings/account")).toBe(false);
    expect(navigation.allowsPath("/new-unclassified-route")).toBe(false);
  });
});
