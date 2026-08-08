import { describe, it, expect } from "vitest";

import {
  draftHasIdentity,
  draftInstant,
  draftToBody,
  emptyDraft,
} from "../vaccination-form";

/**
 * The form's one hard rule: a dose saves with a date and ONE identity arm — a
 * catalogue pick OR the person's own wording — and nothing else. These cover
 * the body derivation that the sheet's Save gate reads.
 */
describe("vaccination form draft", () => {
  it("saves with a date and a catalogue pick alone", () => {
    const body = draftToBody(
      emptyDraft({ occurredAt: "2020-03-04", antigenSlug: "tetanus" }),
    );
    expect(body).not.toBeNull();
    expect(body!.antigenSlug).toBe("tetanus");
    expect(body!.occurredAt).toBe("2020-03-04T00:00:00.000Z");
    // Nothing else is required — the optional fields default to absences.
    expect(body!.vaccineName).toBeNull();
    expect(body!.doseNumber).toBeNull();
    expect(body!.lotNumber).toBeNull();
    expect(body!.site).toBeNull();
    expect(body!.practitionerId).toBeNull();
  });

  it("saves with a date and free text alone", () => {
    const body = draftToBody(
      emptyDraft({ occurredAt: "1987-06-01", vaccineName: "  Old brand  " }),
    );
    expect(body).not.toBeNull();
    expect(body!.antigenSlug).toBeNull();
    expect(body!.vaccineName).toBe("Old brand");
  });

  it("refuses a draft with neither identity arm", () => {
    const draft = emptyDraft({ occurredAt: "2020-01-01" });
    expect(draftHasIdentity(draft)).toBe(false);
    expect(draftToBody(draft)).toBeNull();
  });

  it("refuses a draft with no usable date", () => {
    expect(draftInstant("")).toBeNull();
    expect(draftInstant("not-a-date")).toBeNull();
    expect(
      draftToBody(emptyDraft({ occurredAt: "", antigenSlug: "tetanus" })),
    ).toBeNull();
  });

  it("carries the optional fields through when present", () => {
    const body = draftToBody(
      emptyDraft({
        occurredAt: "2021-09-09",
        antigenSlug: "tdap",
        doseNumber: "3",
        seriesDoses: "3",
        lotNumber: "AB123",
        site: "LEFT_ARM",
        note: "sore arm",
      }),
    );
    expect(body).toMatchObject({
      doseNumber: 3,
      seriesDoses: 3,
      lotNumber: "AB123",
      site: "LEFT_ARM",
      note: "sore arm",
    });
  });
});
