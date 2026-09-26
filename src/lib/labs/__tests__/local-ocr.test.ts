import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The in-browser OCR engine loads from this origin, never from a CDN.
 *
 * tesseract.js defaults its worker, WebAssembly core and language data to
 * cdn.jsdelivr.net. That sends the browser of anyone scanning a lab report
 * to a third party, and the production CSP refuses it, so the feature could
 * not load. These tests pin the options `createWorker` receives and hold them
 * against the files `scripts/stage-tesseract-assets.mjs` actually stages.
 */
const recognize = vi.fn();
const terminate = vi.fn().mockResolvedValue(undefined);
const createWorker = vi.fn();
vi.mock("tesseract.js", () => ({
  createWorker: (...args: unknown[]) => createWorker(...args),
}));

import { LOCAL_OCR_ASSET_OPTIONS, ocrImageToText } from "../local-ocr";

beforeEach(() => {
  recognize.mockReset();
  createWorker.mockReset();
  createWorker.mockResolvedValue({ recognize, terminate });
});

describe("local OCR engine assets", () => {
  it("starts the worker from same-origin paths, not a CDN or a blob", async () => {
    recognize.mockResolvedValue({ data: { text: " Hb 14.2 g/dl " } });
    const file = new File(["x"], "scan.png", { type: "image/png" });

    await expect(ocrImageToText(file)).resolves.toBe("Hb 14.2 g/dl");

    expect(createWorker).toHaveBeenCalledTimes(1);
    const [langs, oem, options] = createWorker.mock.calls[0] as [
      string,
      number,
      Record<string, unknown>,
    ];
    expect(langs).toBe("deu+eng");
    expect(oem).toBe(1);
    expect(options.workerBlobURL).toBe(false);
    for (const key of ["workerPath", "corePath", "langPath"]) {
      const value = String(options[key]);
      expect(value.startsWith("/tesseract/"), `${key}: ${value}`).toBe(true);
    }
    expect(JSON.stringify(options)).not.toMatch(/https?:|jsdelivr/);
  });

  it("points at exactly the files the staging script copies", () => {
    const script = readFileSync(
      join(process.cwd(), "scripts/stage-tesseract-assets.mjs"),
      "utf8",
    );
    // Worker, the three LSTM core builds, and gzipped best_int data for
    // both languages. The worker resolves `${corePath}/<build>.wasm.js` and
    // `${langPath}/<lang>.traineddata.gz`.
    expect(LOCAL_OCR_ASSET_OPTIONS.workerPath).toBe("/tesseract/worker.min.js");
    expect(script).toContain('"worker.min.js"');
    expect(LOCAL_OCR_ASSET_OPTIONS.corePath).toBe("/tesseract/core");
    expect(script).toContain('join("core", file)');
    for (const build of [
      "tesseract-core-lstm.wasm.js",
      "tesseract-core-simd-lstm.wasm.js",
      "tesseract-core-relaxedsimd-lstm.wasm.js",
    ]) {
      expect(script).toContain(build);
    }
    expect(LOCAL_OCR_ASSET_OPTIONS.langPath).toBe("/tesseract/lang");
    expect(LOCAL_OCR_ASSET_OPTIONS.gzip).toBe(true);
    expect(script).toContain('join("lang", `${lang}.traineddata.gz`)');
    expect(script).toContain('"4.0.0_best_int"');
  });
});
