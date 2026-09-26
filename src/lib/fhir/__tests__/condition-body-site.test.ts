/**
 * `Condition.bodySite` from the condition journal's free-text site and side.
 *
 * The site rides `text`; the side rides a contained `BodyStructure` reached
 * through the core `bodySite` extension, and is repeated in `text` so a
 * receiver that ignores extensions still reads which side.
 */
import { describe, expect, it } from "vitest";

import type { DoctorReportData } from "@/lib/doctor-report-data";
import { conditionsFromReportData } from "@/lib/fhir/resources";
import type { FhirCondition } from "@/lib/fhir/types";

type Episode = NonNullable<DoctorReportData["illnessEpisodes"]>[number];

function conditionFor(extra: Partial<Episode>): FhirCondition {
  const data = {
    illnessEpisodes: [
      {
        label: "Sprain",
        type: "INJURY",
        lifecycle: "ACUTE",
        onsetAt: "2026-04-01T00:00:00.000Z",
        resolvedAt: null,
        ...extra,
      },
    ],
  } as unknown as DoctorReportData;
  const [condition] = conditionsFromReportData(data).conditions;
  if (!condition) throw new Error("no Condition emitted");
  return condition;
}

describe("conditionsFromReportData — bodySite", () => {
  it("emits no bodySite and nothing contained when no site was recorded", () => {
    const c = conditionFor({});
    expect(c.bodySite).toBeUndefined();
    expect(c.contained).toBeUndefined();
  });

  it("treats a blank site as no site, even with a side", () => {
    const c = conditionFor({ bodySite: "   ", laterality: "LEFT" });
    expect(c.bodySite).toBeUndefined();
    expect(c.contained).toBeUndefined();
  });

  it("emits the site as text only when no side was stated", () => {
    const c = conditionFor({ bodySite: "Lower back", laterality: null });
    expect(c.bodySite).toEqual([{ text: "Lower back" }]);
    expect(c.contained).toBeUndefined();
  });

  it.each([
    ["LEFT", "419161000", "Unilateral left", "left"],
    ["RIGHT", "419465000", "Unilateral right", "right"],
    ["BOTH", "51440002", "Bilateral", "both sides"],
  ])(
    "carries %s as SNOMED %s on a contained BodyStructure",
    (laterality, code, display, sideText) => {
      const c = conditionFor({ bodySite: "Knee", laterality });
      expect(c.bodySite).toEqual([
        {
          extension: [
            {
              url: "http://hl7.org/fhir/StructureDefinition/bodySite",
              valueReference: { reference: "#bodysite-1" },
            },
          ],
          text: `Knee (${sideText})`,
        },
      ]);
      expect(c.contained).toEqual([
        {
          resourceType: "BodyStructure",
          id: "bodysite-1",
          location: { text: "Knee" },
          locationQualifier: [
            {
              coding: [{ system: "http://snomed.info/sct", code, display }],
              text: sideText,
            },
          ],
          patient: { reference: "Patient/patient-1" },
        },
      ]);
    },
  );

  it("never puts the side into bodySite.coding", () => {
    const c = conditionFor({ bodySite: "Knee", laterality: "RIGHT" });
    expect(c.bodySite?.[0]?.coding).toBeUndefined();
  });

  it("falls back to the site alone for an unknown side value", () => {
    const c = conditionFor({ bodySite: "Knee", laterality: "SIDEWAYS" });
    expect(c.bodySite).toEqual([{ text: "Knee" }]);
    expect(c.contained).toBeUndefined();
  });

  it("keeps each episode's site on its own Condition", () => {
    const data = {
      illnessEpisodes: [
        {
          label: "A",
          type: "INJURY",
          lifecycle: "ACUTE",
          onsetAt: "2026-04-01T00:00:00.000Z",
          resolvedAt: null,
          bodySite: "Wrist",
          laterality: "RIGHT",
        },
        {
          label: "B",
          type: "INFECTION",
          lifecycle: "ACUTE",
          onsetAt: "2026-04-02T00:00:00.000Z",
          resolvedAt: null,
        },
      ],
    } as unknown as DoctorReportData;
    const [a, b] = conditionsFromReportData(data).conditions;
    expect(a?.bodySite?.[0]?.text).toBe("Wrist (right)");
    expect(b?.bodySite).toBeUndefined();
    expect(b?.contained).toBeUndefined();
  });
});
