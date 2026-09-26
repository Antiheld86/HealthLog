/**
 * v1.18.10 — in-browser (local) OCR for lab-report scans.
 *
 * Used by the TEXT-mode Lab-OCR path: a user whose AI provider cannot read
 * images (ChatGPT-OAuth/Codex, a text-only model) OCR's the photo HERE, in the
 * browser, and only the extracted TEXT is POSTed to `/api/labs/ocr/extract`.
 * The raw image never leaves the device.
 *
 * tesseract.js (WASM) is LAZY-loaded via `await import(...)` so the multi-MB
 * worker + WASM core + `deu+eng` traineddata land in the browser only when the
 * user actually scans in text mode — never at app boot, and never for the
 * higher-accuracy vision path. This mirrors the chart-defer discipline.
 *
 * Images only — tesseract.js cannot read PDFs, matching the vision path's
 * image-only constraint for non-Anthropic providers.
 *
 * Every engine file is served from this origin under `/tesseract/`, staged
 * from node_modules by `scripts/stage-tesseract-assets.mjs`. The library's
 * defaults fetch the worker, the WebAssembly core and the language data from
 * cdn.jsdelivr.net, which both sends the user's browser to a third party and
 * is refused by the production CSP. The worker is started from its URL, not
 * from a blob, so `worker-src 'self'` admits it.
 */

/** German + English: a German lab sheet needs `deu` for ä/ö/ü/ß; `eng` covers
 * the many English analyte names and units that appear on the same sheet. */
const OCR_LANGS = "deu+eng";

/** OEM 1 (LSTM only), the library default, spelled out because the staged
 * core builds and the `best_int` language data are the LSTM-only ones. */
const OCR_OEM = 1;

/** Same-origin engine paths; see `scripts/stage-tesseract-assets.mjs`. */
export const LOCAL_OCR_ASSET_OPTIONS = {
  workerPath: "/tesseract/worker.min.js",
  corePath: "/tesseract/core",
  langPath: "/tesseract/lang",
  workerBlobURL: false,
  gzip: true,
} as const;

export class LocalOcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalOcrError";
  }
}

/**
 * OCR an image file entirely in the browser and return the extracted plain
 * text. Throws `LocalOcrError` when the engine fails to load or recognise.
 *
 * A fresh worker is created and terminated per call. The traineddata is
 * browser-cached after the first run, so the cost is paid once.
 */
export async function ocrImageToText(file: File): Promise<string> {
  // Lazy import — keeps tesseract.js out of the main bundle.
  let createWorker: typeof import("tesseract.js").createWorker;
  try {
    ({ createWorker } = await import("tesseract.js"));
  } catch {
    throw new LocalOcrError("Failed to load the local OCR engine");
  }

  const worker = await createWorker(
    OCR_LANGS,
    OCR_OEM,
    LOCAL_OCR_ASSET_OPTIONS,
  );
  try {
    const {
      data: { text },
    } = await worker.recognize(file);
    const trimmed = text.trim();
    if (!trimmed) {
      throw new LocalOcrError("No text could be read from the image");
    }
    return trimmed;
  } catch (err) {
    if (err instanceof LocalOcrError) throw err;
    throw new LocalOcrError("Local OCR failed to read the image");
  } finally {
    // Free the WASM worker; the traineddata stays browser-cached.
    await worker.terminate().catch(() => {});
  }
}
