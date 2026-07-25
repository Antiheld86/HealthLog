/**
 * Structural guard: a rendered export control with no gating path fails the
 * build.
 *
 * The health-record export panel shipped twenty data-selection switches, of
 * which eight changed nothing at all. `toDoctorReportPrefs` folded the grouped
 * wire shape down to twelve flat flags and dropped the rest on the floor, so a
 * user who switched off SpO₂, body fat, body composition, resting heart rate,
 * HRV, VO₂max, steps or distance exported them anyway — in the PDF, in the FHIR
 * bundle, in the package, in a clinician share link and over MCP. Nothing
 * failed; the control simply lied, and it lied for several releases because no
 * test connected "the panel renders this" to "the export honours this".
 *
 * This file is that connection, in three links that each break independently:
 *
 *   1. Every control the panel holds state for survives the wire schema. A key
 *      the schema strips can never be honoured, however carefully the fold is
 *      written.
 *   2. Flipping exactly one control changes the resolved `DoctorReportPrefs`
 *      the aggregator consumes. This is the assertion that would have caught
 *      all eight dead switches on the day they were added.
 *   3. Every flag in the resolved shape is read downstream — either as a
 *      per-measurement-type entry in the selection gates or by name in the
 *      aggregator body. A flag nothing reads is the same defect one layer down.
 *
 * It also checks the panel actually renders every control it declares, so the
 * split between the control shape and its rendering cannot quietly leave a
 * declared control with no row (or a row with no gate).
 *
 * What it does NOT prove: that the excluded data is actually absent from a
 * rendered artefact. That is a behavioural property and it is covered where the
 * artefacts are built — `src/app/api/export/health-record/__tests__/route.test.ts`
 * asserts the PDF, the FHIR bundle and the zip for the same selections. This
 * guard is the cheap structural half that runs on every commit and cannot be
 * satisfied by writing a control that looks plausible.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  exportSectionsSchema,
  toDoctorReportPrefs,
} from "@/lib/validations/health-record-export";
import {
  DEFAULT_DOCTOR_REPORT_PREFS,
  type DoctorReportPrefs,
} from "@/lib/validations/doctor-report-prefs";
import {
  DEFAULT_SECTIONS,
  buildSelectionSections,
  type SectionState,
} from "@/components/settings/health-record-export-controls";
import { MEASUREMENT_TYPE_SECTION } from "@/lib/doctor-report-selection";

const REPO_ROOT = join(__dirname, "..", "..");
const PANEL_PATH = join(
  REPO_ROOT,
  "src",
  "components",
  "settings",
  "health-record-export-panel.tsx",
);
const AGGREGATOR_PATH = join(REPO_ROOT, "src", "lib", "doctor-report-data.ts");

const panelSource = readFileSync(PANEL_PATH, "utf8");
const aggregatorSource = readFileSync(AGGREGATOR_PATH, "utf8");

/** Strip comments so a key mentioned only in prose does not count as read. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The control set, taken from the panel's own starting values rather than from
 * a list this test maintains — a list would drift exactly the way the fold
 * drifted. `DEFAULT_SECTIONS` is typed `SectionState`, so TypeScript already
 * forces it to name every control, and every rendered row must bind one of
 * them. "Declared here" and "rendered" are therefore the same set.
 */
const CONTROL_KEYS = Object.keys(DEFAULT_SECTIONS) as (keyof SectionState)[];

/** All controls on, as the panel's state shape. */
function allOn(): SectionState {
  return Object.fromEntries(
    CONTROL_KEYS.map((k) => [k, true]),
  ) as unknown as SectionState;
}

/**
 * The exact path a selection takes in production: panel state → grouped wire
 * shape → the route's Zod parse (which strips anything the schema does not
 * declare) → the flat prefs the aggregator consumes.
 */
function resolve(state: SectionState): DoctorReportPrefs {
  return toDoctorReportPrefs(
    exportSectionsSchema.parse(buildSelectionSections(state)),
  );
}

describe("export control gating — structural guard", () => {
  it("reads a plausible control set", () => {
    // Sanity floor: if the control shape silently degraded, every assertion
    // below would pass vacuously.
    expect(CONTROL_KEYS.length).toBeGreaterThanOrEqual(20);
    expect(CONTROL_KEYS).toContain("bp");
    expect(CONTROL_KEYS).toContain("mentalHealthScreeners");
  });

  it("renders a row for every control it declares", () => {
    const unrendered = CONTROL_KEYS.filter(
      (key) => !panelSource.includes(`sections.${key}`),
    );
    expect(
      unrendered,
      `These controls are declared in the selection shape but the panel binds ` +
        `no row to them, so the user has no way to reach them.`,
    ).toEqual([]);
  });

  it("keeps every rendered control inside the wire schema", () => {
    const wire = buildSelectionSections(allOn());
    // A round trip through the schema must not lose anything the panel sends.
    expect(exportSectionsSchema.parse(wire)).toEqual(wire);
  });

  it("makes flipping any single control change the resolved selection", () => {
    const baseline = resolve(allOn());
    const inert: string[] = [];

    for (const key of CONTROL_KEYS) {
      const flipped = resolve({ ...allOn(), [key]: false });
      if (JSON.stringify(flipped) === JSON.stringify(baseline)) {
        inert.push(key);
      }
    }

    expect(
      inert,
      `These panel controls are rendered but change nothing in the resolved ` +
        `export selection. Give each one a flag in DoctorReportPrefs and a ` +
        `gating path in doctor-report-data.ts, or remove the control.`,
    ).toEqual([]);
  });

  it("has something downstream read every flag in the resolved selection", () => {
    // A flag is honoured either by gating measurement types or by name in the
    // aggregator body (the structured sections: labs, allergies, the
    // medication block, the glucose panel).
    const mappedFlags = new Set<string>(
      Object.values(MEASUREMENT_TYPE_SECTION),
    );
    const body = stripComments(aggregatorSource);

    const unread = Object.keys(DEFAULT_DOCTOR_REPORT_PREFS).filter(
      (key) => !mappedFlags.has(key) && !body.includes(`sections.${key}`),
    );

    expect(
      unread,
      `These resolved selection flags are never read downstream, so switching ` +
        `them off would change nothing that leaves the instance.`,
    ).toEqual([]);
  });

  it("keeps the sensitive selections off unless asked for by name", () => {
    // Mood, cycle and the screening instruments must never ride an absent key:
    // the mental-health module went default-ON in v1.29.1 and silently made
    // PHQ-9 and GAD-7 totals part of a default export.
    const fromNothing = toDoctorReportPrefs(undefined);
    expect(fromNothing.mood).toBe(false);
    expect(fromNothing.cycle).toBe(false);
    expect(fromNothing.mentalHealthScreeners).toBe(false);

    // A partial selection that names other things must not flip them on.
    const partial = toDoctorReportPrefs({ labs: true, vitals: { bp: true } });
    expect(partial.mood).toBe(false);
    expect(partial.cycle).toBe(false);
    expect(partial.mentalHealthScreeners).toBe(false);

    // Only an explicit `true` does.
    expect(
      toDoctorReportPrefs({ mentalHealthScreeners: true })
        .mentalHealthScreeners,
    ).toBe(true);
  });
});
