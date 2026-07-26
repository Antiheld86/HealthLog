import { describe, it, expect } from "vitest";
import { toProfileSex, binaryReferenceSex } from "@/lib/profile/sex";

/**
 * The column holds three values. Two separate defects shipped from code
 * that could only hold two: the FHIR export mapped the third to `female`,
 * and the Strain model scored it on the male coefficients. These two
 * functions are the only sanctioned way to move between the widths.
 */
describe("toProfileSex", () => {
  it("carries every stored value through", () => {
    expect(toProfileSex("MALE")).toBe("MALE");
    expect(toProfileSex("FEMALE")).toBe("FEMALE");
    expect(toProfileSex("OTHER")).toBe("OTHER");
  });

  it("reports no answer as no answer, and never guesses one", () => {
    expect(toProfileSex(null)).toBeNull();
    expect(toProfileSex(undefined)).toBeNull();
    expect(toProfileSex("")).toBeNull();
    expect(toProfileSex("male")).toBeNull();
    expect(toProfileSex("diverse")).toBeNull();
  });
});

describe("binaryReferenceSex", () => {
  it("keeps the two values a sex-split reference table has rows for", () => {
    expect(binaryReferenceSex("MALE")).toBe("MALE");
    expect(binaryReferenceSex("FEMALE")).toBe("FEMALE");
  });

  it("resolves the third value to null rather than to one of the two", () => {
    expect(binaryReferenceSex("OTHER")).toBeNull();
    expect(binaryReferenceSex(null)).toBeNull();
    expect(binaryReferenceSex(undefined)).toBeNull();
    expect(binaryReferenceSex("")).toBeNull();
  });
});
