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
import { resolveRecordPresentation } from "@/lib/navigation/record-presentation";

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

  it("keeps profile facts outside Settings and makes profile the scoped doorway", () => {
    const navigation = resolveSharedRecordNavigation(["profile"]);

    expect(SHARED_RECORD_DOMAIN_ROUTE_FAMILIES.profile).toEqual([
      "/profile",
      "/checkups",
    ]);
    expect(navigation.destinationHrefs).toEqual(["/profile", "/checkups"]);
    expect(navigation.allowsPath("/profile")).toBe(true);
    expect(navigation.allowsPath("/settings/anamnesis")).toBe(false);
  });

  it("presents the checkups page under both domains whose content it shows", () => {
    // The page holds two things: the preventive-care list, which is a
    // `measurements` read, and the visits section, which is `profile`. A grant
    // naming either one must be able to reach it; a grant naming neither must
    // not. Before the visits section the `measurements` omission was invisible,
    // because a whole-record grant admits every path regardless.
    expect(
      resolveSharedRecordNavigation(["measurements"]).allowsPath("/checkups"),
    ).toBe(true);
    expect(
      resolveSharedRecordNavigation(["profile"]).allowsPath("/checkups"),
    ).toBe(true);
    expect(resolveSharedRecordNavigation(null).allowsPath("/checkups")).toBe(
      true,
    );
    expect(
      resolveSharedRecordNavigation(["labs"]).allowsPath("/checkups"),
    ).toBe(false);

    // Listed twice, offered once: a grant holding both domains must not put
    // two identical entries in the navigation.
    expect(
      resolveSharedRecordNavigation([
        "measurements",
        "profile",
      ]).destinationHrefs.filter((href) => href === "/checkups"),
    ).toEqual(["/checkups"]);
  });

  it("uses the active record scope instead of the actor's module flags", () => {
    const actorModules = {
      medications: false,
      labs: false,
      mood: false,
      mentalHealth: false,
      cycle: false,
      illness: false,
      inboundDocuments: false,
    };

    expect(
      visibleNavDestinations(actorModules, true, true, ["medications"]).map(
        (destination) => destination.href,
      ),
    ).toEqual(["/medications"]);
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

  it("keeps server-resolved access and record kind distinct in chrome", () => {
    expect(
      resolveRecordPresentation({
        level: "read",
        canWrite: false,
        recordKind: "shared",
      }),
    ).toEqual({ access: "view", recordKind: "shared" });
    expect(
      resolveRecordPresentation({
        level: "write",
        canWrite: true,
        recordKind: "shared",
      }),
    ).toEqual({ access: "view-and-add", recordKind: "shared" });
    expect(
      resolveRecordPresentation({
        level: "manage",
        canWrite: true,
        recordKind: "shared",
      }),
    ).toEqual({ access: "manage", recordKind: "shared" });
    expect(
      resolveRecordPresentation({
        level: "manage",
        canWrite: true,
        recordKind: "managed",
      }),
    ).toEqual({ access: "manage", recordKind: "managed" });
  });

  it("fails closed when a malformed entry reaches presentation", () => {
    expect(
      resolveRecordPresentation({
        level: "manage",
        canWrite: false,
        recordKind: "managed",
      } as never),
    ).toEqual({ access: "view", recordKind: "self" });

    expect(
      resolveRecordPresentation({
        level: "unknown",
        canWrite: true,
        recordKind: "shared",
      } as never),
    ).toEqual({ access: "view", recordKind: "self" });
  });
});
