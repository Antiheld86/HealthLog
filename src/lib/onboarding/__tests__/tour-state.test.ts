import { describe, expect, it } from "vitest";

import {
  buildTourStops,
  currentStop,
  deriveProgress,
  initTourState,
  isTourFinished,
  nextStep,
  prevStep,
  skipTour,
  stepCounter,
  dropRedirectedStop,
  stopRouteRedirected,
} from "../tour-state";

const FULL_ORDER = [
  "dashboardOverview",
  "quickAdd",
  "measurements",
  "medications",
  "labs",
  "illness",
  "vorsorge",
  "cycle",
  "mood",
  "insights",
  "coach",
  "integrations",
  "export",
  "achievements",
  "wrapUp",
];

describe("tour-state", () => {
  describe("buildTourStops()", () => {
    it("returns all 15 module stops in order with every module on", () => {
      const stops = buildTourStops();
      expect(stops.map((s) => s.id)).toEqual(FULL_ORDER);
    });

    it("drops a stop whose module resolves to false (default-on otherwise)", () => {
      const stops = buildTourStops({
        modules: { cycle: false, mood: false, achievements: false },
      });
      const ids = stops.map((s) => s.id);
      expect(ids).not.toContain("cycle");
      expect(ids).not.toContain("mood");
      expect(ids).not.toContain("achievements");
      // Core + un-disabled modules survive.
      expect(ids).toContain("dashboardOverview");
      expect(ids).toContain("labs");
      expect(ids).toContain("wrapUp");
    });

    it("keeps the Insights stop with AI analysis off", () => {
      const stops = buildTourStops({ modules: { insights: false } });
      expect(stops.map((s) => s.id)).toContain("insights");
    });

    it("drops the Coach and Medications stops with their modules off", () => {
      const ids = buildTourStops({
        modules: { coach: false, medications: false },
      }).map((s) => s.id);
      expect(ids).not.toContain("coach");
      expect(ids).not.toContain("medications");
    });

    it("keeps a module stop when its key is absent or true (fail-open)", () => {
      const stops = buildTourStops({ modules: { labs: true } });
      expect(stops.map((s) => s.id)).toContain("labs");
      expect(stops.map((s) => s.id)).toContain("mood");
    });

    it("filterToStop narrows to a single module card", () => {
      const stops = buildTourStops({ filterToStop: "labs" });
      expect(stops.map((s) => s.id)).toEqual(["labs"]);
    });

    it("filterToStop yields nothing when the module is disabled", () => {
      const stops = buildTourStops({
        filterToStop: "cycle",
        modules: { cycle: false },
      });
      expect(stops).toEqual([]);
    });

    it("every stop carries a distinct, namespaced i18n title and body key", () => {
      for (const s of buildTourStops()) {
        expect(s.titleKey).toMatch(/^onboarding\.tour\.steps\./);
        expect(s.bodyKey).toMatch(/^onboarding\.tour\.steps\./);
        expect(s.titleKey).not.toBe(s.bodyKey);
      }
    });

    it("every cross-page stop declares a route; the wrap-up is centred + routeless", () => {
      for (const s of buildTourStops()) {
        if (s.id === "wrapUp") {
          expect(s.targetId).toBeNull();
          expect(s.route).toBeUndefined();
          expect(s.placement).toBe("center");
        } else {
          expect(typeof s.route).toBe("string");
          expect(s.targetId).toBeTruthy();
        }
      }
    });
  });

  describe("navigation", () => {
    it("starts at index 0 with outcome null", () => {
      const state = initTourState(buildTourStops());
      expect(state.index).toBe(0);
      expect(state.outcome).toBeNull();
      expect(currentStop(state)?.id).toBe("dashboardOverview");
    });

    it("resumes from a persisted stop id", () => {
      const state = initTourState(buildTourStops(), "labs");
      expect(currentStop(state)?.id).toBe("labs");
    });

    it("ignores a resume id absent from the resolved list", () => {
      const state = initTourState(
        buildTourStops({ modules: { cycle: false } }),
        "cycle",
      );
      expect(state.index).toBe(0);
    });

    it("nextStep advances through the list", () => {
      let state = initTourState(buildTourStops());
      state = nextStep(state);
      expect(currentStop(state)?.id).toBe("quickAdd");
    });

    it("nextStep on the last step finishes with outcome=completed", () => {
      const stops = buildTourStops();
      let state = initTourState(stops);
      for (let i = 0; i < stops.length; i++) state = nextStep(state);
      expect(state.outcome).toBe("completed");
      expect(isTourFinished(state)).toBe(true);
      expect(currentStop(state)).toBeNull();
    });

    it("prevStep is pinned at index 0", () => {
      const state = initTourState(buildTourStops());
      expect(prevStep(state).index).toBe(0);
    });

    it("skipTour from any step finishes with outcome=skipped", () => {
      let state = initTourState(buildTourStops());
      state = nextStep(state);
      const skipped = skipTour(state);
      expect(skipped.outcome).toBe("skipped");
      expect(currentStop(skipped)).toBeNull();
    });
  });

  describe("stepCounter", () => {
    it("reports 1-based current and the resolved total", () => {
      const stops = buildTourStops();
      let state = initTourState(stops);
      expect(stepCounter(state)).toEqual({ current: 1, total: stops.length });
      state = nextStep(state);
      expect(stepCounter(state).current).toBe(2);
    });

    it("total tracks the gated list so the counter stays honest", () => {
      const stops = buildTourStops({ modules: { cycle: false, mood: false } });
      const state = initTourState(stops);
      expect(stepCounter(state).total).toBe(stops.length);
      expect(stops.length).toBe(13);
    });
  });

  describe("deriveProgress", () => {
    it("reports the current stop as the resume point while running", () => {
      let state = initTourState(buildTourStops());
      state = nextStep(state);
      state = nextStep(state);
      const p = deriveProgress(state);
      expect(p.lastStopId).toBe("measurements");
      expect(p.status).toBe("in_progress");
      expect(p.completedStopIds).toEqual([
        "dashboardOverview",
        "quickAdd",
        "measurements",
      ]);
    });

    it("marks completed with every stop reached and a null resume point", () => {
      const stops = buildTourStops();
      let state = initTourState(stops);
      for (let i = 0; i < stops.length; i++) state = nextStep(state);
      const p = deriveProgress(state);
      expect(p.status).toBe("completed");
      expect(p.lastStopId).toBeNull();
      expect(p.completedStopIds).toHaveLength(stops.length);
    });

    it("marks skipped", () => {
      let state = initTourState(buildTourStops());
      state = skipTour(state);
      expect(deriveProgress(state).status).toBe("skipped");
    });
  });
});

describe("a stop whose page sends the person elsewhere", () => {
  const coach = "/coach";

  it("is not redirected before the tour navigated for it", () => {
    expect(
      stopRouteRedirected({
        stopRoute: coach,
        pathname: "/insights",
        pushedFrom: null,
        arrived: false,
      }),
    ).toBe(false);
  });

  it("is not redirected while the navigation is still on its way", () => {
    expect(
      stopRouteRedirected({
        stopRoute: coach,
        pathname: "/insights",
        pushedFrom: "/insights",
        arrived: false,
      }),
    ).toBe(false);
  });

  it("is not redirected once it stands on its page", () => {
    expect(
      stopRouteRedirected({
        stopRoute: coach,
        pathname: coach,
        pushedFrom: "/insights",
        arrived: true,
      }),
    ).toBe(false);
  });

  it("is redirected when its page sent the person back to where they came from", () => {
    // The Coach page answers an unavailable Coach with a redirect to
    // /insights, the previous stop's page: /insights → /coach → /insights.
    expect(
      stopRouteRedirected({
        stopRoute: coach,
        pathname: "/insights",
        pushedFrom: "/insights",
        arrived: true,
      }),
    ).toBe(true);
  });

  it("is redirected when the navigation landed on a third page", () => {
    expect(
      stopRouteRedirected({
        stopRoute: coach,
        pathname: "/",
        pushedFrom: "/insights",
        arrived: false,
      }),
    ).toBe(true);
  });

  it("is dropped going forward: the next stop takes its place and Back never lands on it", () => {
    const steps = buildTourStops();
    const at = steps.findIndex((s) => s.id === "coach");
    const state = dropRedirectedStop(
      { index: at, steps, outcome: null },
      "forward",
    );
    expect(currentStop(state)?.id).toBe("integrations");
    expect(state.steps.map((s) => s.id)).not.toContain("coach");
    expect(currentStop(prevStep(state))?.id).toBe("insights");
  });

  it("is dropped going back: the previous stop takes over", () => {
    const steps = buildTourStops();
    const at = steps.findIndex((s) => s.id === "coach");
    const state = dropRedirectedStop(
      { index: at, steps, outcome: null },
      "back",
    );
    expect(currentStop(state)?.id).toBe("insights");
  });

  it("completes the tour when the dropped stop was the last one", () => {
    const steps = buildTourStops().slice(0, 3);
    const state = dropRedirectedStop(
      { index: 2, steps, outcome: null },
      "forward",
    );
    expect(state.outcome).toBe("completed");
  });
});

describe("the tour's Coach stop follows the Coach's capability", () => {
  it("drops the Coach stop from a capability-folded module map", () => {
    // `useNavModules()` folds an unavailable Coach capability (no provider,
    // no consent) into `coach: false`; the tour reads that map.
    const ids = buildTourStops({ modules: { coach: false } }).map((s) => s.id);
    expect(ids).not.toContain("coach");
  });
});
