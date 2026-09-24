import { describe, expect, it } from "vitest";

import { hideModuleWidgets } from "@/lib/dashboard/widget-modules";

const layout = {
  version: 2,
  widgets: [
    { id: "weight", visible: true, tileVisible: true, order: 0 },
    { id: "medications", visible: true, tileVisible: true, order: 1 },
    { id: "mood", visible: true, tileVisible: true, order: 2 },
    { id: "hrv", visible: true, tileVisible: true, order: 3 },
  ],
};

describe("hideModuleWidgets", () => {
  it("hides the widgets of a switched-off module and keeps their order", () => {
    const out = hideModuleWidgets(layout, { medications: false });
    expect(out.widgets.map((w) => [w.id, w.visible, w.tileVisible])).toEqual([
      ["weight", true, true],
      ["medications", false, false],
      ["mood", true, true],
      ["hrv", true, true],
    ]);
  });

  it("hides the ids it is told to on top of the module mask", () => {
    const out = hideModuleWidgets(layout, {}, new Set(["hrv"]));
    expect(out.widgets.find((w) => w.id === "hrv")?.visible).toBe(false);
    expect(out.widgets.find((w) => w.id === "mood")?.visible).toBe(true);
  });

  it("is a no-op before the module map is known", () => {
    expect(hideModuleWidgets(layout, undefined).widgets).toEqual(
      layout.widgets,
    );
  });

  it("never writes through to the layout it was given", () => {
    hideModuleWidgets(layout, { mood: false, medications: false });
    expect(layout.widgets.every((w) => w.visible)).toBe(true);
  });
});
