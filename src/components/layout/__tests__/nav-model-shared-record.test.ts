/**
 * What the navigation offers inside somebody else's record.
 *
 * Paint, not enforcement — every route behind a hidden entry refuses on its
 * own, from a frozen allowlist this model cannot reach. What these pin is that
 * the line is drawn in ONE place: the mobile bar's fixed slots, the sidebar,
 * the More hub and the shell's deep-link guard all ask the same list, so they
 * cannot end up disagreeing about what a delegate is offered.
 *
 * The default is the safe one. A destination that says nothing about sharing
 * drops out, so a surface added later is hidden until somebody has thought
 * about it rather than exposed until somebody notices.
 *
 * Mutation check, run: flip the default in `isNavDestinationVisible` so an
 * unflagged destination survives a switch → "hides everything that has not
 * been classified" goes red naming Insights and the Coach.
 *
 * Mutation checks for the utility tail, run against `visibleUtilityDestinations`:
 *   - restore the old empty tail for every shared record → both "offers
 *     Settings" cases and the parity case go red (3);
 *   - point the switched entry at the fixed `/settings/account` → the adult
 *     MANAGE case and the parity case go red (2);
 *   - keep Notifications in the switched tail beside the remapped Settings
 *     entry → "never offers Notifications under a switch" goes red, with the
 *     two "offers Settings" cases and the parity case (4).
 */
import { describe, expect, it } from "vitest";

import { SETTINGS_SECTIONS } from "@/components/settings/settings-shell";
import {
  isSettingsDestinationListedForRecord,
  type SettingsRecordContext,
} from "@/lib/record-settings/classification";

import {
  BOTTOM_NAV_PRIMARY_SLOT_HREFS,
  NAV_DESTINATIONS,
  isDestinationInSharedRecord,
  mobileMoreHubDestinations,
  visibleNavDestinations,
  visibleUtilityDestinations,
} from "../nav-model";

/** Everything enabled, so the module gate never masks the sharing gate. */
const ALL_MODULES = Object.fromEntries(
  NAV_DESTINATIONS.filter((d) => d.requiresModule).map((d) => [
    d.requiresModule as string,
    true,
  ]),
);

function hrefsInSharedRecord(): string[] {
  return visibleNavDestinations(ALL_MODULES, true, true).map((d) => d.href);
}

describe("the destination list under a switch", () => {
  it("still offers the health record itself", () => {
    const hrefs = hrefsInSharedRecord();
    // The non-zero proof for every negative assertion below: a gate that hid
    // everything would satisfy all of them and leave a delegate with a blank
    // app.
    expect(hrefs.length).toBeGreaterThan(5);
    expect(hrefs).toContain("/");
    expect(hrefs).toContain("/measurements");
    expect(hrefs).toContain("/medications");
    expect(hrefs).toContain("/labs");
  });

  it("hides everything that has not been classified", () => {
    const hrefs = hrefsInSharedRecord();
    const unflagged = NAV_DESTINATIONS.filter((d) => !d.sharedRecord).map(
      (d) => d.href,
    );
    // Non-zero: if every destination were flagged this loop would assert
    // nothing at all.
    expect(unflagged.length).toBeGreaterThan(0);
    for (const href of unflagged) {
      expect(
        hrefs,
        `${href} should not be offered inside a shared record`,
      ).not.toContain(href);
    }
  });

  it("hides the AI surfaces by name", () => {
    // Not incidental. Server-managed LLM egress of a person's health data
    // rides the consent THAT person gave for their own use, so a delegate
    // triggering it would create a consent-shaped act the owner never made.
    const hrefs = hrefsInSharedRecord();
    expect(hrefs).not.toContain("/insights");
    expect(hrefs).not.toContain("/coach");
  });

  it("changes nothing for a session in its own record", () => {
    const own = visibleNavDestinations(ALL_MODULES, true).map((d) => d.href);
    expect(own).toEqual(
      NAV_DESTINATIONS.filter((d) => !d.sharedRecordOnly).map((d) => d.href),
    );
    expect(own).not.toContain("/profile");
  });

  it("offers the read-only profile summary only inside a shared record", () => {
    expect(hrefsInSharedRecord()).toContain("/profile");
  });
});

describe("a module the RECORD does not track", () => {
  /**
   * #939 — the map `GET /api/auth/me` publishes is the RECORD's while a
   * session is switched into one, so this filter is what makes a guardian's
   * toggle visible. Before it, turning Cycle off for a profile left the Cycle
   * door standing in that profile's own navigation, and the toggle wrote a
   * column nothing on screen was reading.
   */
  it("drops its destination inside the record", () => {
    const withCycle = visibleNavDestinations(ALL_MODULES, true, true, null).map(
      (d) => d.href,
    );
    expect(withCycle).toContain("/cycle");

    const withoutCycle = visibleNavDestinations(
      { ...ALL_MODULES, cycle: false },
      true,
      true,
      null,
    ).map((d) => d.href);
    expect(withoutCycle).not.toContain("/cycle");
    // Only that one door: a module toggle is not a scope change.
    expect(withoutCycle).toContain("/measurements");
  });
});

describe("the utility tail under a switch", () => {
  const MANAGED_AT_MANAGE: SettingsRecordContext = {
    recordKind: "managed",
    level: "manage",
  };
  const SHARED_AT_MANAGE: SettingsRecordContext = {
    recordKind: "shared",
    level: "manage",
  };

  const hrefs = (record: SettingsRecordContext | null) =>
    visibleUtilityDestinations({ record }).map((d) => d.href);

  it("keeps both utilities in one's own record", () => {
    expect(hrefs(null)).toEqual(["/settings/account", "/notifications"]);
    expect(visibleUtilityDestinations().map((d) => d.href)).toEqual(
      hrefs(null),
    );
  });

  /**
   * #939 — a self-hoster looking after a managed profile was told to open
   * Settings → Modules inside it and could not find Settings anywhere: the
   * tail used to be empty for every shared record, while the Settings shell
   * lists the profile's own configuration there. The entry is offered again,
   * and it opens on a page the shell admits.
   */
  it("offers Settings inside a managed profile, because the shell has pages for it there", () => {
    const tail = visibleUtilityDestinations({ record: MANAGED_AT_MANAGE });
    expect(tail.map((d) => d.tKey)).toEqual(["nav.settings"]);
    // The profile card: `account` is classified managed-guardian and is the
    // first section the shell lists for a managed record.
    expect(tail[0].href).toBe("/settings/account");
  });

  it("offers Settings to an adult MANAGE share, landing on the only page it opens", () => {
    // `/settings/account` is refused in an adult share; the one destination
    // listed there is the record content, so the entry must not point at the
    // account page the bar uses in one's own record.
    expect(hrefs(SHARED_AT_MANAGE)).toEqual(["/settings/anamnesis"]);
  });

  it("offers nothing to a READ or WRITE share, where the shell lists nothing", () => {
    for (const recordKind of ["shared", "managed"] as const) {
      for (const level of ["read", "write"] as const) {
        expect(hrefs({ recordKind, level })).toEqual([]);
      }
    }
  });

  it("offers nothing to a refused or pending switch, which carries no level", () => {
    // `resolveRecordCapabilities` answers `recordKind: "shared", level: null`
    // for both; a Settings entry there would lead into a context nobody has
    // proven.
    expect(hrefs({ recordKind: "shared", level: null })).toEqual([]);
  });

  it("never offers Notifications under a switch", () => {
    // Notifications is the delegate's own device business; its routes refuse
    // under a switch at every level and for every record kind.
    for (const recordKind of ["shared", "managed"] as const) {
      for (const level of ["read", "write", "manage", null] as const) {
        expect(hrefs({ recordKind, level })).not.toContain("/notifications");
      }
    }
  });

  it("lands on the first section the Settings shell lists, for every record kind", () => {
    // The parity net. The navigation walks the slug registry, the shell walks
    // its own ordered section list; both filter with the same predicate, and
    // this holds the first answers equal so a reorder on either side cannot
    // land somebody on a page the shell does not open with.
    const contexts: SettingsRecordContext[] = [
      MANAGED_AT_MANAGE,
      SHARED_AT_MANAGE,
    ];
    for (const record of contexts) {
      const firstListed = SETTINGS_SECTIONS.find((section) =>
        isSettingsDestinationListedForRecord(section.slug, record),
      );
      // Non-zero: a predicate that listed nothing would make both sides
      // agree on "no entry" and prove nothing about the landing.
      expect(firstListed, record.recordKind).toBeDefined();
      // A module-gated landing could vanish from the shell when its module is
      // off, leaving the entry pointing at a section the list no longer shows.
      expect(firstListed?.moduleGate, record.recordKind).toBeUndefined();
      expect(hrefs(record)).toEqual([`/settings/${firstListed?.slug}`]);
    }
  });
});

describe("the mobile bar under a switch", () => {
  it("drops the same entries from the More hub", () => {
    const hub = mobileMoreHubDestinations({
      modules: ALL_MODULES,
      sharedRecord: true,
    }).map((d) => d.href);
    expect(hub.length).toBeGreaterThan(0);
    expect(hub).not.toContain("/coach");
    expect(hub).toContain("/measurements");
    for (const slot of BOTTOM_NAV_PRIMARY_SLOT_HREFS) {
      expect(hub).not.toContain(slot);
    }
  });

  it("answers for the fixed Insights slot from the same list", () => {
    // The bar carries its own literal for the fixed slots. Having it ASK the
    // model rather than carry a second answer is what stops the two surfaces
    // drifting — which is the whole reason this module exists.
    expect(isDestinationInSharedRecord("/insights")).toBe(false);
    expect(isDestinationInSharedRecord("/medications")).toBe(true);
  });
});

describe("the deep-link guard reads the same list", () => {
  it("covers a destination and everything beneath it", () => {
    expect(isDestinationInSharedRecord("/measurements")).toBe(true);
    expect(isDestinationInSharedRecord("/measurements/abc123")).toBe(true);
    expect(isDestinationInSharedRecord("/labs/panel/7")).toBe(true);
  });

  it("matches the dashboard exactly, so it does not swallow the app", () => {
    // `"/"` is a destination like any other, and a prefix match on it would
    // report every path in the product as covered — including /settings.
    expect(isDestinationInSharedRecord("/")).toBe(true);
    expect(isDestinationInSharedRecord("/settings/account")).toBe(false);
    expect(isDestinationInSharedRecord("/notifications")).toBe(false);
  });

  it("answers false for a path no destination claims", () => {
    // A surface nobody has classified is not one to open inside somebody
    // else's record.
    expect(isDestinationInSharedRecord("/some/new/surface")).toBe(false);
  });
});
