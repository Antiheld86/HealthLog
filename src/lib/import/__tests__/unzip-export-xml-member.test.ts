import { describe, expect, it } from "vitest";

import { selectExportXmlEntry } from "../unzip-export-xml";

/**
 * Which member of an Apple Health archive holds the export.
 *
 * iOS writes the file name in the phone's language and some versions
 * capitalise it, so `apple_health_export/Export.xml` and translated spellings
 * are ordinary archives, not broken ones. Matching the English lowercase name
 * alone turned them away with a message claiming the export was invalid.
 */
const entry = (fileName: string) => ({ fileName });

describe("selecting the export XML member", () => {
  it("takes the documented lowercase name", () => {
    const result = selectExportXmlEntry([
      entry("apple_health_export/export.xml"),
      entry("apple_health_export/export_cda.xml"),
    ]);
    expect(result).toEqual({
      entry: entry("apple_health_export/export.xml"),
    });
  });

  it("takes the same name capitalised, which iOS also writes", () => {
    // The decoy matters: with only one plausible XML left, the fallback for
    // translated names would pick the right file anyway and this case would
    // pass even against a strictly lowercase match.
    const result = selectExportXmlEntry([
      entry("apple_health_export/Export.xml"),
      entry("apple_health_export/Activities.xml"),
      entry("apple_health_export/export_cda.xml"),
    ]);
    expect(result).toEqual({
      entry: entry("apple_health_export/Export.xml"),
    });
  });

  it("takes a translated name when it is the only candidate", () => {
    const result = selectExportXmlEntry([
      entry("apple_health_export/Exportar.xml"),
      entry("apple_health_export/Exportar_cda.xml"),
      entry("apple_health_export/electrocardiograms/ecg_2026-01-01.csv"),
    ]);
    expect(result).toEqual({
      entry: entry("apple_health_export/Exportar.xml"),
    });
  });

  it("never takes the clinical-document file, which parses to nothing", () => {
    const result = selectExportXmlEntry([
      entry("apple_health_export/export_cda.xml"),
    ]);
    expect(result).toEqual({
      candidates: ["apple_health_export/export_cda.xml"],
    });
  });

  it("ignores the resource fork a macOS re-zip adds", () => {
    const result = selectExportXmlEntry([
      entry("__MACOSX/apple_health_export/._export.xml"),
      entry("apple_health_export/export.xml"),
    ]);
    expect(result).toEqual({
      entry: entry("apple_health_export/export.xml"),
    });
  });

  it("names what it did find when nothing qualifies", () => {
    const result = selectExportXmlEntry([
      entry("apple_health_export/one.xml"),
      entry("apple_health_export/two.xml"),
    ]);
    expect(result).toEqual({
      candidates: [
        "apple_health_export/one.xml",
        "apple_health_export/two.xml",
      ],
    });
  });
});
