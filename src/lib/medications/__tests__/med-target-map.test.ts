import { describe, it, expect } from "vitest";
import {
  inferMedTargetClass,
  primaryTargetForClass,
  MED_TARGET_MAP,
  MED_NEEDLE_STEMS,
  resolveMedicationTargets,
  targetsForEfficacyClass,
} from "@/lib/medications/med-target-map";

describe("med-target-map — class inference", () => {
  it("maps the structured GLP1 discriminator", () => {
    expect(inferMedTargetClass("Anything", "GLP1")).toBe("glp1");
  });

  it("recognises a GLP-1 brand via the catalog", () => {
    expect(inferMedTargetClass("Mounjaro")).toBe("glp1");
    expect(inferMedTargetClass("Ozempic")).toBe("glp1");
  });

  it("recognises a GLP-1 INN by name", () => {
    expect(inferMedTargetClass("semaglutide 1mg")).toBe("glp1");
  });

  it("maps common antihypertensives", () => {
    expect(inferMedTargetClass("Ramipril")).toBe("antihypertensive");
    expect(inferMedTargetClass("amlodipine 5mg")).toBe("antihypertensive");
    expect(inferMedTargetClass("Bisoprolol")).toBe("antihypertensive");
  });

  it("maps common antidiabetics", () => {
    expect(inferMedTargetClass("Metformin 1000mg")).toBe("antidiabetic");
    expect(inferMedTargetClass("insulin glargine")).toBe("antidiabetic");
  });

  it("conservative-fails on an unknown medication", () => {
    expect(inferMedTargetClass("Aspirin")).toBeNull();
    expect(inferMedTargetClass("Vitamin D")).toBeNull();
    expect(inferMedTargetClass("")).toBeNull();
  });

  it("does not match a partial-word false positive", () => {
    // "insuline-like" should not match the whole word "insulin" boundary —
    // and an unrelated name must stay unknown.
    expect(inferMedTargetClass("Paracetamol")).toBeNull();
  });
});

describe("med-target-map — targets", () => {
  it("leads antihypertensive with systolic", () => {
    expect(primaryTargetForClass("antihypertensive")).toBe(
      "BLOOD_PRESSURE_SYS",
    );
    expect(MED_TARGET_MAP.antihypertensive).toContain("BLOOD_PRESSURE_DIA");
  });

  it("targets glucose for antidiabetics and glucose+weight for GLP-1", () => {
    expect(MED_TARGET_MAP.antidiabetic).toEqual(["BLOOD_GLUCOSE"]);
    expect(MED_TARGET_MAP.glp1).toEqual(["BLOOD_GLUCOSE", "WEIGHT"]);
  });
});

describe("resolveMedicationTargets — three-tier efficacy resolution", () => {
  it("prefers the ATC class prefix over the name", () => {
    // C09 (ACE/ARB) → blood pressure, even when the name is unrecognised.
    const r = resolveMedicationTargets({
      name: "SomeUnknownBrand",
      atcCode: "C09AA05",
    });
    expect(r?.tier).toBe("atc");
    expect(r?.cls).toBe("antihypertensive");
    expect(r?.targets[0]).toEqual({
      kind: "metric",
      measurementType: "BLOOD_PRESSURE_SYS",
    });
  });

  it("maps the lipid-modifier ATC class to an LDL lab target", () => {
    const r = resolveMedicationTargets({ name: "x", atcCode: "C10AA05" });
    expect(r?.cls).toBe("statin");
    expect(r?.targets[0]).toEqual({
      kind: "lab",
      analyte: "LDL",
      label: "LDL cholesterol",
    });
  });

  it("routes the GLP-1 ATC leaf to glucose+weight, not the A10 fallback", () => {
    const r = resolveMedicationTargets({ name: "x", atcCode: "A10BJ06" });
    expect(r?.cls).toBe("glp1");
    const other = resolveMedicationTargets({ name: "x", atcCode: "A10BA02" });
    expect(other?.cls).toBe("antidiabetic");
  });

  it("maps thyroid ATC to a TSH lab target", () => {
    const r = resolveMedicationTargets({ name: "x", atcCode: "H03AA01" });
    expect(r?.cls).toBe("thyroid");
    expect(r?.targets[0].kind).toBe("lab");
  });

  it("falls back to name inference when no valid ATC code is present", () => {
    const r = resolveMedicationTargets({ name: "Atorvastatin 20mg" });
    expect(r?.tier).toBe("name");
    expect(r?.cls).toBe("statin");
    const bp = resolveMedicationTargets({ name: "Ramipril" });
    expect(bp?.tier).toBe("name");
    expect(bp?.cls).toBe("antihypertensive");
  });

  it("infers supplement lab targets by name", () => {
    expect(resolveMedicationTargets({ name: "Cholecalciferol" })?.cls).toBe(
      "vitamin_d",
    );
    expect(
      resolveMedicationTargets({ name: "Ferrous sulfate 200mg" })?.cls,
    ).toBe("iron");
  });

  it("ignores a malformed ATC code and falls through to the name", () => {
    const r = resolveMedicationTargets({
      name: "Ramipril",
      atcCode: "not-an-atc",
    });
    expect(r?.tier).toBe("name");
    expect(r?.cls).toBe("antihypertensive");
  });

  it("conservative-fails to null for an unknown med with no ATC", () => {
    expect(resolveMedicationTargets({ name: "Aspirin" })).toBeNull();
    expect(resolveMedicationTargets({ name: "" })).toBeNull();
  });

  it("exposes the ordered target list per efficacy class", () => {
    expect(targetsForEfficacyClass("antihypertensive")).toHaveLength(2);
    expect(targetsForEfficacyClass("thyroid")[0]).toEqual({
      kind: "lab",
      analyte: "TSH",
      label: "TSH",
    });
  });
});

// ── national INN spellings ───────────────────────────────────────────
//
// The needle lists are drug names, not app-owned labels: there is no bundle
// to derive them from. What there IS is the regularity of the INN system —
// `Metformin`, `Metformine`, `Metformina` and `Metforminum` are one molecule
// under four national conventions. The matcher folds both sides to a
// normalised INN stem instead of enumerating languages, so all of these reach
// the same class off ONE English needle.
describe("med-target-map — national INN spellings fold to one stem", () => {
  it.each([
    // antidiabetic
    ["de", "Metformin 1000mg", "antidiabetic"],
    ["fr", "Metformine 1000 mg", "antidiabetic"],
    ["es", "Metformina 1000 mg", "antidiabetic"],
    ["it", "Metformina", "antidiabetic"],
    ["pl", "Metformina", "antidiabetic"],
    ["la", "Metforminum", "antidiabetic"],
    ["fr", "Insuline glargine", "antidiabetic"],
    ["es", "Insulina glargina", "antidiabetic"],
    ["pl", "Empagliflozyna 10 mg", "antidiabetic"],
    ["pl", "Gliklazyd 30 mg", "antidiabetic"],
    ["pl", "Sitagliptyna", "antidiabetic"],
    ["es", "Pioglitazona", "antidiabetic"],
    // GLP-1
    ["de", "Semaglutid 1 mg", "glp1"],
    ["fr", "Sémaglutide 1 mg", "glp1"],
    ["es", "Semaglutida", "glp1"],
    ["pl", "Semaglutyd", "glp1"],
    ["de", "Tirzepatid", "glp1"],
    ["pl", "Liraglutyd", "glp1"],
    ["pl", "Eksenatyd", "glp1"],
    // antihypertensive
    ["de", "Amlodipin 5mg", "antihypertensive"],
    ["es", "Amlodipino 5 mg", "antihypertensive"],
    ["pl", "Amlodypina 5 mg", "antihypertensive"],
    ["pl", "Ramipryl 5 mg", "antihypertensive"],
    ["it", "Bisoprololo 2,5 mg", "antihypertensive"],
    ["pl", "Karwedilol", "antihypertensive"],
    ["pl", "Nebiwolol", "antihypertensive"],
    ["pl", "Walsartan 80 mg", "antihypertensive"],
    ["pl", "Kandesartan", "antihypertensive"],
    ["it", "Idroclorotiazide", "antihypertensive"],
    ["pl", "Hydrochlorotiazyd", "antihypertensive"],
    ["de", "Furosemid 40 mg", "antihypertensive"],
    ["pl", "Doksazosyna", "antihypertensive"],
    ["pl", "Lizynopryl", "antihypertensive"],
    ["de", "Enalapril", "antihypertensive"],
    ["pl", "Kaptopril", "antihypertensive"],
  ] as const)("reads the %s spelling %s as %s", (_lang, name, cls) => {
    expect(inferMedTargetClass(name)).toBe(cls);
  });

  it("carries the fold into the lab-target classes too", () => {
    expect(resolveMedicationTargets({ name: "Atorwastatyna 20 mg" })?.cls).toBe(
      "statin",
    );
    expect(resolveMedicationTargets({ name: "Atorvastatina 20 mg" })?.cls).toBe(
      "statin",
    );
    expect(resolveMedicationTargets({ name: "Rozuwastatyna" })?.cls).toBe(
      "statin",
    );
    expect(resolveMedicationTargets({ name: "Lewotyroksyna" })?.cls).toBe(
      "thyroid",
    );
    expect(resolveMedicationTargets({ name: "Levotiroxina 75 µg" })?.cls).toBe(
      "thyroid",
    );
    expect(resolveMedicationTargets({ name: "L-Thyroxin 100" })?.cls).toBe(
      "thyroid",
    );
    expect(resolveMedicationTargets({ name: "Cholekalcyferol" })?.cls).toBe(
      "vitamin_d",
    );
    expect(resolveMedicationTargets({ name: "Colecalciferolo" })?.cls).toBe(
      "vitamin_d",
    );
  });

  it("names iron by its element, which is a word list and not an INN", () => {
    // Iron preparations are named for the element, so no INN stem exists to
    // fold to. The element word IS in every language, hand-tabulated.
    expect(
      resolveMedicationTargets({ name: "Ferrous sulfate 200mg" })?.cls,
    ).toBe("iron");
    expect(resolveMedicationTargets({ name: "Fer 14 mg" })?.cls).toBe("iron");
    expect(resolveMedicationTargets({ name: "Eisen 100 mg" })?.cls).toBe(
      "iron",
    );
    expect(resolveMedicationTargets({ name: "Hierro 80 mg" })?.cls).toBe(
      "iron",
    );
    expect(resolveMedicationTargets({ name: "Żelazo 50 mg" })?.cls).toBe(
      "iron",
    );
  });

  it("keeps every English name resolving exactly as before", () => {
    expect(inferMedTargetClass("Metformin 1000mg")).toBe("antidiabetic");
    expect(inferMedTargetClass("insulin glargine")).toBe("antidiabetic");
    expect(inferMedTargetClass("semaglutide 1mg")).toBe("glp1");
    expect(inferMedTargetClass("Ramipril")).toBe("antihypertensive");
    expect(inferMedTargetClass("amlodipine 5mg")).toBe("antihypertensive");
    expect(inferMedTargetClass("Bisoprolol")).toBe("antihypertensive");
    expect(inferMedTargetClass("Mounjaro")).toBe("glp1");
    expect(inferMedTargetClass("Ozempic")).toBe("glp1");
    expect(resolveMedicationTargets({ name: "Atorvastatin 20mg" })?.cls).toBe(
      "statin",
    );
    expect(resolveMedicationTargets({ name: "Cholecalciferol" })?.cls).toBe(
      "vitamin_d",
    );
  });

  // The fold is only safe if it keeps molecules apart. A rewrite rule that
  // merged two of them would map a real drug to the wrong class silently.
  it("keeps every needle's stem unique across classes", () => {
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const [cls, stems] of Object.entries(MED_NEEDLE_STEMS)) {
      for (const stem of stems) {
        const claimed = owner.get(stem);
        if (claimed !== undefined && claimed !== cls) {
          collisions.push(`${stem}: ${claimed} + ${cls}`);
        }
        owner.set(stem, cls);
      }
    }
    expect(collisions).toEqual([]);
  });

  it("keeps every stem long enough not to collide with an ordinary word", () => {
    const short = Object.values(MED_NEEDLE_STEMS)
      .flat()
      .filter((stem) => stem.length < 5)
      .sort();
    // The two deliberately short ones are element names, not INN stems; the
    // whole-token rule is what keeps them safe.
    expect(short).toEqual(["fer", "iron"]);
  });

  it("still conservative-fails — a looser fold must not invent a class", () => {
    expect(inferMedTargetClass("Aspirin")).toBeNull();
    expect(inferMedTargetClass("Paracetamol")).toBeNull();
    expect(inferMedTargetClass("Ibuprofen")).toBeNull();
    expect(inferMedTargetClass("Vitamin D")).toBeNull();
    expect(inferMedTargetClass("Pantoprazol")).toBeNull();
    expect(inferMedTargetClass("Amoxicillin")).toBeNull();
    expect(inferMedTargetClass("")).toBeNull();
    expect(resolveMedicationTargets({ name: "Aspirin" })).toBeNull();
    // A word that merely CONTAINS a stem is not a whole-token hit.
    expect(
      inferMedTargetClass("Metforminhydrochlorid-Fertigarznei"),
    ).toBeNull();
  });
});
