/**
 * Structural guard (a tripwire, not a proof) for the metric/imperial unit
 * fix (issue #627). The dangerous failure mode is a PARTIAL fix: entry converts
 * but a display surface still hardcodes the canonical unit, so an imperial user
 * sees converted-then-mislabelled soup. This walks the dashboard + insight page
 * sources and asserts none of them passes a transformed type's DISPLAY UNIT
 * (kg / lb / cm / in / °C / °F / km/h / mph / km / mi) or a hardcoded value
 * scale as a literal prop — those must resolve from the user's preference
 * through `useUnitDisplay()` instead.
 *
 * Mutation check: add `unit="kg"` back to any swept page and this goes red.
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  getDisplayTransform,
  TRANSFORMED_TYPES,
} from "@/lib/measurements/display-transform";

const SRC = join(process.cwd(), "src");

/** The set of display-unit strings a transformed type can render. */
const TRANSFORMED_UNITS: ReadonlySet<string> = new Set(
  [...TRANSFORMED_TYPES].flatMap((type) => [
    getDisplayTransform(type, "metric").displayUnit,
    getDisplayTransform(type, "imperial").displayUnit,
  ]),
);

/**
 * v1.32.27 — the target/threshold subsystem. These three files are the
 * coupled display+edit unit: the reference panel that RENDERS a target
 * band, the sheet that EDITS it, and the settings editor that edits the
 * same thresholds from the other end. A partial wire here is worse than
 * none — a converted display over a canonical save silently rewrites
 * the user's stored target — so they are swept for hardcoded units AND
 * asserted to route through the preference hook.
 */
const TARGET_SURFACES = [
  join(SRC, "components", "insights", "metric-target-summary.tsx"),
  join(SRC, "components", "targets", "target-edit-sheet.tsx"),
  join(SRC, "components", "settings", "thresholds-editor-section.tsx"),
];

/**
 * Swept surfaces: the dashboard client, every insights sub-page, and the
 * target/threshold surfaces.
 */
function sweptFiles(): string[] {
  return [
    join(SRC, "app", "page-client.tsx"),
    ...globSync("app/insights/**/page.tsx", { cwd: SRC }).map((rel) =>
      join(SRC, rel),
    ),
    ...TARGET_SURFACES,
  ];
}

describe("unit-preference display guard", () => {
  it("sweeps a non-empty set of surfaces", () => {
    // Guards against a glob that silently matches nothing (a green void).
    expect(sweptFiles().length).toBeGreaterThan(10);
  });

  it("no swept surface hardcodes a transformed type's display unit", () => {
    const offenders: string[] = [];
    for (const file of sweptFiles()) {
      const src = readFileSync(file, "utf8");
      for (const unit of TRANSFORMED_UNITS) {
        // Match `unit="kg"` / `yAxisUnit="°C"` exactly (closing quote pinned so
        // `unit="kg/m²"` — the excluded BMI unit — never trips it).
        for (const prop of ["unit", "yAxisUnit"]) {
          if (src.includes(`${prop}="${unit}"`)) {
            offenders.push(`${file}: ${prop}="${unit}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no insights page hardcodes a numeric valueScale literal", () => {
    // Transformed metrics resolve their scale from the transform; a literal
    // `valueScale={3.6}` is the pre-fix hand-rolled scaling that double-scales.
    const literal = /valueScale=\{\s*-?\d/;
    const offenders = sweptFiles().filter((file) =>
      literal.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("every target/threshold surface resolves its unit from the preference", () => {
    // The tripwire for a silent un-wire: delete the hook import from any
    // of the three and the surface falls back to canonical kilograms
    // while its sibling still shows pounds.
    // The call site, not the import — swapping the hook out for a
    // hardcoded "metric" literal while leaving the import behind is
    // exactly the un-wire this has to catch.
    const offenders = TARGET_SURFACES.filter(
      (file) => !readFileSync(file, "utf8").includes("useUnitDisplay()"),
    );
    expect(offenders).toEqual([]);
  });

  it("every target/threshold surface converts through the shared adapter", () => {
    // One adapter owns seed, guardrail, save, and unit label for all
    // three surfaces. A surface that hand-rolls its own conversion (or
    // announces `METRIC_BOUNDS[metric].unit`, the canonical symbol)
    // is how the display and the edit halves drift apart.
    const offenders: string[] = [];
    for (const file of TARGET_SURFACES) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("resolveTargetUnitAdapter")) {
        offenders.push(`${file}: no adapter`);
      }
      if (/METRIC_BOUNDS\[[^\]]+\]\.unit/.test(src)) {
        offenders.push(`${file}: canonical bound unit rendered`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every transformed type carries both a metric and an imperial branch", () => {
    for (const type of TRANSFORMED_TYPES) {
      const metric = getDisplayTransform(type, "metric");
      const imperial = getDisplayTransform(type, "imperial");
      expect(metric.displayUnit).toBeTruthy();
      expect(imperial.displayUnit).toBeTruthy();
      expect(Number.isFinite(metric.factor)).toBe(true);
      expect(Number.isFinite(imperial.factor)).toBe(true);
    }
  });
});
