"use client";

/**
 * v1.27.22 (Document vault P2) — the shared client transport for the document
 * AI routes (suggest / summary / index). One place decides VISION vs local-OCR
 * TEXT so every affordance posts a shape the endpoint accepts:
 *   - `mode: "vision"` → an empty-body POST; the server decrypts the stored
 *     original and runs one provider call.
 *   - `mode: "text"`  → the browser OCR's the image on-device (tesseract, lazy
 *     loaded) and posts ONLY the text. Images only — a PDF/attachment in text
 *     mode is refused client-side before any download/OCR work.
 *
 * A provider call is slow, so requests opt out of the default 15 s fetch window
 * in favour of a generous ceiling.
 */
import { apiFetchRaw, apiPost } from "@/lib/api/api-fetch";
import { ocrImageToText, LocalOcrError } from "@/lib/labs/local-ocr";

/** The transport an AI call uses, resolved from the OCR capability probe. */
export type DocumentAiMode = "vision" | "text";

/** The document facts the transport needs to fetch + OCR the original. */
export interface DocumentAiTarget {
  documentId: string;
  mimeType: string;
  filename: string | null;
  servingClass: "inline" | "attachment";
}

/**
 * A client-side precondition failure that never reached the server (the image
 * couldn't be fetched, the file isn't an image for text mode, or local OCR
 * failed). Carries a stable `reason` the UI maps to a translated message.
 */
export class DocumentAssistClientError extends Error {
  readonly reason: "textImageOnly" | "originalFetch" | "ocr";
  constructor(reason: DocumentAssistClientError["reason"]) {
    super(reason);
    this.name = "DocumentAssistClientError";
    this.reason = reason;
  }
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/** Fetch the stored original as a `File` for in-browser OCR (same-origin). */
async function fetchOriginalAsFile(target: DocumentAiTarget): Promise<File> {
  let res: Response;
  try {
    res = await apiFetchRaw(
      `/api/documents/inbound/${target.documentId}/original`,
      { signal: AbortSignal.timeout(30_000) },
    );
  } catch {
    throw new DocumentAssistClientError("originalFetch");
  }
  if (!res.ok) throw new DocumentAssistClientError("originalFetch");
  const blob = await res.blob();
  return new File([blob], target.filename ?? "document", {
    type: blob.type || target.mimeType,
  });
}

/** Run one document AI call over the chosen transport. */
export async function runDocumentAi<T>(opts: {
  path: string;
  mode: DocumentAiMode;
  target: DocumentAiTarget;
}): Promise<T> {
  if (opts.mode === "text") {
    if (
      opts.target.servingClass !== "inline" ||
      !isImageMime(opts.target.mimeType)
    ) {
      // tesseract.js reads images only — refuse before any download/OCR work.
      throw new DocumentAssistClientError("textImageOnly");
    }
    const file = await fetchOriginalAsFile(opts.target);
    let text: string;
    try {
      text = await ocrImageToText(file);
    } catch (err) {
      throw err instanceof LocalOcrError
        ? new DocumentAssistClientError("ocr")
        : err;
    }
    return apiPost<T>(
      opts.path,
      { mode: "text", text },
      { signal: AbortSignal.timeout(120_000) },
    );
  }
  // Vision: empty body → the route dispatches to its vision handler.
  return apiPost<T>(opts.path, undefined, {
    signal: AbortSignal.timeout(120_000),
  });
}

/** The index route's result, including the lab-staging continuation. */
export interface DocumentIndexResult {
  indexed: boolean;
  tokenCount: number;
  /**
   * How many lab facts the read continued into staging (PENDING, for the
   * review step). 0 when the document is not a lab report or staging was not
   * eligible. Confirmation stays the only write into Labs.
   */
  labFactsStaged: number;
}

/** Populate / refresh one document's content index over the chosen transport. */
export function runDocumentIndex(opts: {
  mode: DocumentAiMode;
  target: DocumentAiTarget;
}): Promise<DocumentIndexResult> {
  return runDocumentAi<DocumentIndexResult>({
    path: `/api/documents/inbound/${opts.target.documentId}/index`,
    mode: opts.mode,
    target: opts.target,
  });
}
