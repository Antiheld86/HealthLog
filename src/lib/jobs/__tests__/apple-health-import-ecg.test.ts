import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { APPLE_HEALTH_IMPORT_PARSER_REVISION } from "../apple-health-import-worker";

const workerSource = readFileSync(
  join(process.cwd(), "src/lib/jobs/apple-health-import-worker.ts"),
  "utf8",
);
const parserSource = readFileSync(
  join(process.cwd(), "src/lib/measurements/import-apple-health-export.ts"),
  "utf8",
);

describe("Apple Health import worker — ECG auxiliary branch contract", () => {
  it("bumps the parser revision so completed revision-2 archives reprocess", () => {
    expect(APPLE_HEALTH_IMPORT_PARSER_REVISION).toBeGreaterThan(2);
  });

  it("runs bounded ECG archive ingestion beside the established XML parser", () => {
    expect(workerSource).toMatch(/streamAppleHealthEcgMembers/);
    expect(workerSource).toMatch(/parseAppleHealthEcgCsv/);
    expect(workerSource).toMatch(/importAppleHealthEcg/);
    expect(workerSource).toMatch(/streamParseExportXml/);
  });

  it("catches per-ECG failures without routing the valid XML result to the fatal job catch", () => {
    expect(workerSource).toMatch(
      /for await[\s\S]*streamAppleHealthEcgMembers[\s\S]*try[\s\S]*parseAppleHealthEcgCsv[\s\S]*catch[\s\S]*ecg\.failed/,
    );
    expect(workerSource).toMatch(
      /result[\s\S]*ecg:\s*\{[\s\S]*discovered[\s\S]*imported[\s\S]*updated[\s\S]*skipped[\s\S]*failed/,
    );
  });

  it("keeps progress bounded to scalar ECG counts", () => {
    expect(parserSource).toMatch(
      /ecg:\s*\{[\s\S]*discovered:\s*number[\s\S]*imported:\s*number[\s\S]*updated:\s*number[\s\S]*skipped:\s*number[\s\S]*failed:\s*number/,
    );
    expect(parserSource).not.toMatch(
      /ecg:\s*\{[^}]*?(?:samples|waveform|filename|sourceName|healthValue):/,
    );
  });

  it("does not log ECG filenames, source labels, samples, or raw parser errors", () => {
    const loggingCalls =
      workerSource.match(/console\.(?:log|warn|error)\([\s\S]{0,250}\)/g) ?? [];
    const ecgLogging = loggingCalls.filter((call) =>
      /ecg|electrocardiogram/i.test(call),
    );

    expect(ecgLogging.join("\n")).not.toMatch(
      /member|filename|sourceName|sample|waveform|\$\{(?:err|error)\}/i,
    );
  });

  it("does not claim to diagnose or reclassify a waveform", () => {
    expect(workerSource).not.toMatch(
      /(?:diagnose|infer|classify)Ecg|analy[sz]eWaveform|detectA(?:fib|trial)/i,
    );
  });
});
