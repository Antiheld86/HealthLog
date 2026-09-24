/**
 * v1.17.1 (F-1 / F-3) — the one navigation information-model.
 *
 * Pins the coherence contract the desktop sidebar and the mobile
 * bottom-nav both consume: one ordered destination list (so the two bars
 * tell one story), the Coach as a first-class destination on both
 * surfaces, cycle gated by the account flag, and an active-resolver that
 * prefers the most-specific sibling under `/insights`. (v1.18.0 —
 * Workouts and Recovery left the left nav for their Insights pills.)
 */
import { describe, expect, it } from "vitest";

import {
  BOTTOM_NAV_PRIMARY_SLOT_HREFS,
  NAV_DESTINATIONS,
  NAV_UTILITY_DESTINATIONS,
  isNavDestinationActive,
  mobileMoreHubDestinations,
  visibleNavDestinations,
  visibleUtilityDestinations,
} from "../nav-model";

describe("nav-model destination list", () => {
  it("lists Coach as a first-class destination", () => {
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    expect(hrefs).toContain("/coach");
  });

  it("gives the Coach exactly one nav home at the top-level /coach (F-3)", () => {
    const coach = NAV_DESTINATIONS.filter((d) => d.href === "/coach");
    expect(coach).toHaveLength(1);
    expect(coach[0]!.tKey).toBe("nav.coach");
  });

  it("orders the core spine: dashboard → measurements → mood → medications", () => {
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    expect(hrefs.indexOf("/")).toBeLessThan(hrefs.indexOf("/measurements"));
    expect(hrefs.indexOf("/measurements")).toBeLessThan(hrefs.indexOf("/mood"));
    expect(hrefs.indexOf("/mood")).toBeLessThan(hrefs.indexOf("/medications"));
  });

  it("every destination carries an i18n key under the nav namespace", () => {
    for (const d of NAV_DESTINATIONS) {
      expect(d.tKey.startsWith("nav.")).toBe(true);
    }
  });

  it("gives Checkups a top-level nav home in the clinical spine (N-3)", () => {
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    expect(hrefs).toContain("/checkups");
    const vorsorge = NAV_DESTINATIONS.find((d) => d.href === "/checkups");
    expect(vorsorge?.tKey).toBe("nav.vorsorge");
    // v1.19.1 (S4) — the fixed spine is Medications → Checkups → Labs →
    // Illness → Insights, so Checkups sits after Medications and before Labs.
    expect(hrefs.indexOf("/medications")).toBeLessThan(
      hrefs.indexOf("/checkups"),
    );
    expect(hrefs.indexOf("/checkups")).toBeLessThan(hrefs.indexOf("/labs"));
    expect(hrefs.indexOf("/labs")).toBeLessThan(hrefs.indexOf("/insights"));
  });

  it("does not list Recovery as a left-nav destination (it is an Insights pill)", () => {
    // v1.18.0 — Recovery moved off the left nav and surfaces as an
    // Insights tab-strip pill at `/insights/recovery` instead.
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    expect(hrefs).not.toContain("/insights/recovery");
  });
});

describe("nav-model utility tail (N-1 — one shared list)", () => {
  it("every utility destination carries a nav-namespace i18n key", () => {
    for (const d of NAV_UTILITY_DESTINATIONS) {
      expect(d.tKey.startsWith("nav.")).toBe(true);
    }
  });

  it("lists the shared utility surfaces (Settings, Notifications)", () => {
    const hrefs = NAV_UTILITY_DESTINATIONS.map((d) => d.href);
    expect(hrefs).toContain("/settings/account");
    expect(hrefs).toContain("/notifications");
  });

  it("keeps a stable order (Settings → Notifications)", () => {
    const hrefs = visibleUtilityDestinations().map((d) => d.href);
    expect(hrefs.indexOf("/settings/account")).toBeLessThan(
      hrefs.indexOf("/notifications"),
    );
  });
});

describe("visibleNavDestinations module gate", () => {
  it("includes Cycle (between Mood and Medications) only when its module is enabled", () => {
    // v1.18.0 — cycle is `requiresModule: "cycle"` and reads the delegated
    // `cycle` key from the same resolved module map every other gate uses.
    // v1.19.1 (S4) — cycle sits in the head block, after Mood and before the
    // fixed Medications → … → Achievements spine.
    const off = visibleNavDestinations({ cycle: false }).map((d) => d.href);
    const on = visibleNavDestinations({ cycle: true }).map((d) => d.href);
    expect(off).not.toContain("/cycle");
    expect(on).toContain("/cycle");
    expect(on.indexOf("/mood")).toBeLessThan(on.indexOf("/cycle"));
    expect(on.indexOf("/cycle")).toBeLessThan(on.indexOf("/medications"));
  });

  it("drops a module-gated entry (mood / labs / coach / achievements / medications) when its module is disabled", () => {
    const disabled = visibleNavDestinations({
      mood: false,
      labs: false,
      coach: false,
      achievements: false,
      // v1.18.1 (D3) — medications graduated to a toggleable module.
      medications: false,
    }).map((d) => d.href);
    expect(disabled).not.toContain("/mood");
    expect(disabled).not.toContain("/labs");
    expect(disabled).not.toContain("/coach");
    expect(disabled).not.toContain("/achievements");
    expect(disabled).not.toContain("/medications");
  });

  it("keeps Insights with AI analysis off: the insights key owns no destination", () => {
    const hrefs = visibleNavDestinations({ insights: false }).map(
      (d) => d.href,
    );
    expect(hrefs).toContain("/insights");
  });

  it("keeps every module-gated entry when its module is enabled", () => {
    const enabled = visibleNavDestinations({
      mood: true,
      labs: true,
      coach: true,
      achievements: true,
      insights: true,
      medications: true,
    }).map((d) => d.href);
    expect(enabled).toContain("/mood");
    expect(enabled).toContain("/labs");
    expect(enabled).toContain("/coach");
    expect(enabled).toContain("/achievements");
    expect(enabled).toContain("/insights");
    expect(enabled).toContain("/medications");
  });

  it("fails open: a missing key or an undefined map keeps the gated entry", () => {
    // Default-on contract — a stale /me payload (no module map) must not
    // blank the nav. An empty map and `undefined` both keep every entry.
    const emptyMap = visibleNavDestinations({}).map((d) => d.href);
    const noMap = visibleNavDestinations(undefined).map((d) => d.href);
    for (const hrefs of [emptyMap, noMap]) {
      expect(hrefs).toContain("/mood");
      expect(hrefs).toContain("/cycle");
      expect(hrefs).toContain("/labs");
      expect(hrefs).toContain("/coach");
      expect(hrefs).toContain("/achievements");
    }
    // Core / fail-open destinations render regardless of the map. Medications
    // is module-gated (v1.18.1 D3) but fails open on a missing key.
    expect(emptyMap).toContain("/measurements");
    expect(emptyMap).toContain("/medications");
    expect(emptyMap).toContain("/insights");
    expect(emptyMap).toContain("/checkups");
  });
});

describe("mobileMoreHubDestinations — the F-1 mobile invariant (feature-only hub, N-2)", () => {
  it("is exactly the visible feature destinations minus the primary slots (no utility tail)", () => {
    const opts = {
      modules: { cycle: false } as const,
    };
    const hub = mobileMoreHubDestinations(opts).map((d) => d.href);

    const expectedFeatures = visibleNavDestinations(opts.modules)
      .map((d) => d.href)
      .filter((href) => !BOTTOM_NAV_PRIMARY_SLOT_HREFS.includes(href));

    // Feature destinations only — the account utilities never ride the hub.
    expect(hub).toEqual(expectedFeatures);
  });

  it("never contains a primary slot (Home / Meds / Insights)", () => {
    const hub = mobileMoreHubDestinations({
      modules: { cycle: true },
    }).map((d) => d.href);
    for (const slot of BOTTOM_NAV_PRIMARY_SLOT_HREFS) {
      expect(hub).not.toContain(slot);
    }
  });

  it("keeps the feature destinations reachable but excludes the account utilities", () => {
    const hub = mobileMoreHubDestinations({
      modules: { cycle: false },
    }).map((d) => d.href);
    // Feature surfaces that left the always-visible strip stay reachable.
    expect(hub).toContain("/measurements");
    expect(hub).toContain("/mood");
    expect(hub).toContain("/checkups");
    // Settings + Notifications are account utilities — they live ONLY in the
    // user/avatar menu, never duplicated into the mobile More hub.
    expect(hub).not.toContain("/settings/account");
    expect(hub).not.toContain("/notifications");
  });

  it("gates Cycle by the module map, same as the sidebar", () => {
    const off = mobileMoreHubDestinations({
      modules: { cycle: false, mood: false },
    }).map((d) => d.href);
    const on = mobileMoreHubDestinations({
      modules: { cycle: true, mood: true },
    }).map((d) => d.href);
    expect(off).not.toContain("/cycle");
    expect(off).not.toContain("/mood");
    expect(on).toContain("/cycle");
    expect(on).toContain("/mood");
  });
});

describe("isNavDestinationActive most-specific resolution", () => {
  it("matches the dashboard only on an exact path", () => {
    expect(isNavDestinationActive("/", "/")).toBe(true);
    expect(isNavDestinationActive("/", "/measurements")).toBe(false);
  });

  it("lights up the top-level Coach home on its own route", () => {
    expect(isNavDestinationActive("/coach", "/coach")).toBe(true);
    // The standalone /coach route is not a sibling of /insights, so the
    // Insights entry must stay dark on it.
    expect(isNavDestinationActive("/insights", "/coach")).toBe(false);
  });

  it("lights up Insights on its Workouts sub-route (no longer a separate nav home)", () => {
    // v1.18.0 — Workouts left the left nav for its Insights pill, so it is
    // no longer a more-specific NAV_DESTINATIONS sibling. The Insights nav
    // home now reads active on `/insights/workouts`, like any other
    // `/insights/*` sub-route.
    expect(isNavDestinationActive("/insights", "/insights/workouts")).toBe(
      true,
    );
  });

  it("still lights up Insights on its own sub-routes", () => {
    expect(isNavDestinationActive("/insights", "/insights")).toBe(true);
    expect(isNavDestinationActive("/insights", "/insights/values/WEIGHT")).toBe(
      true,
    );
  });
});
