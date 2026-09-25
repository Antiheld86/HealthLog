import { describe, expect, it } from "vitest";

import { MODULE_KEYS } from "@/lib/modules/registry";
import {
  SURFACE_KINDS,
  SURFACE_MODULE,
  isSurfaceVisible,
  surfaceModule,
  surfaceModulesOfKind,
} from "@/lib/modules/surface";

describe("SURFACE_MODULE", () => {
  it("owns every surface by a real module key", () => {
    const keys = new Set<string>(MODULE_KEYS);
    for (const [id, owner] of Object.entries(SURFACE_MODULE)) {
      expect(keys.has(owner), `${id} → ${owner}`).toBe(true);
    }
  });

  it("names every surface as <kind>:<local id> with a known kind", () => {
    const kinds = new Set<string>(SURFACE_KINDS);
    for (const id of Object.keys(SURFACE_MODULE)) {
      const kind = id.slice(0, id.indexOf(":"));
      expect(kinds.has(kind), id).toBe(true);
      expect(id.length).toBeGreaterThan(kind.length + 1);
    }
  });

  it("leaves the Insights area to no module (the insights key is AI analysis only)", () => {
    expect(surfaceModule("nav:/insights")).toBeUndefined();
    expect(Object.values(SURFACE_MODULE)).not.toContain("insights");
  });
});

describe("isSurfaceVisible", () => {
  it("hides an owned surface only on an explicit false", () => {
    expect(isSurfaceVisible("trend:mood", { mood: false })).toBe(false);
    expect(isSurfaceVisible("trend:mood", { mood: true })).toBe(true);
    expect(isSurfaceVisible("trend:mood", {})).toBe(true);
    expect(isSurfaceVisible("trend:mood", undefined)).toBe(true);
  });

  it("never hides a surface no module owns", () => {
    expect(isSurfaceVisible("trend:bp", { mood: false, sleep: false })).toBe(
      true,
    );
    expect(isSurfaceVisible("nav:/measurements", { mood: false })).toBe(true);
  });

  it("reads the owner's key, not the surface's name", () => {
    expect(isSurfaceVisible("capture:medication", { medications: false })).toBe(
      false,
    );
    expect(
      isSurfaceVisible("insights-page:blood-glucose", { glucose: false }),
    ).toBe(false);
  });
});

describe("surfaceModulesOfKind", () => {
  it("strips the kind prefix and keeps only that kind", () => {
    const widgets = surfaceModulesOfKind("widget");
    expect(widgets.mood).toBe("mood");
    expect(widgets.recentWorkouts).toBe("workouts");
    expect(Object.keys(widgets).some((k) => k.includes(":"))).toBe(false);
    expect(widgets["/mood"]).toBeUndefined();
  });

  it("returns an empty view for a kind with no entries rather than throwing", () => {
    for (const kind of SURFACE_KINDS) {
      expect(typeof surfaceModulesOfKind(kind)).toBe("object");
    }
  });
});
