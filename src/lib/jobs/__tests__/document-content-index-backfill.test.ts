import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Content-index backfill (Document vault P2). Pins: no provider / no consent →
 * clean no-op; indexes not-yet-indexed docs; stops when the budget is reached
 * (resumable); skips are bounded by the MIME-filtered candidate set.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: { findMany: vi.fn(), findFirst: vi.fn() },
    documentContentIndex: { upsert: vi.fn() },
  },
}));
vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: vi.fn(() => Buffer.from([1, 2, 3])),
}));
vi.mock("@/lib/labs/ocr-upload", () => ({
  detectOcrMimeType: vi.fn(() => "image/png"),
}));
vi.mock("@/lib/documents/rasterize-pdf", () => ({
  rasterizePdf: vi.fn(),
}));
vi.mock("@/lib/documents/describe", () => ({
  transcribeDocument: vi.fn().mockResolvedValue({ text: "glucose 90" }),
  DocumentDescribeError: class DocumentDescribeError extends Error {},
}));
vi.mock("@/lib/documents/content-index", () => ({
  upsertContentIndex: vi.fn().mockResolvedValue({ tokenCount: 3 }),
}));
vi.mock("@/lib/documents/provider-order", () => ({
  resolveDocumentVisionProvider: vi.fn(),
}));
vi.mock("@/lib/ai/consent-guard", () => ({
  assertDocumentEgressConsent: vi.fn().mockResolvedValue(undefined),
  ConsentRequiredError: class ConsentRequiredError extends Error {},
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-07-07"),
  reserveBudget: vi.fn(),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCap: vi.fn(() => 1000),
}));
vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: vi.fn() }));

import { runContentIndexBackfillForUser } from "../document-content-index-backfill";
import { prisma } from "@/lib/db";
import { detectOcrMimeType } from "@/lib/labs/ocr-upload";
import { rasterizePdf } from "@/lib/documents/rasterize-pdf";
import { transcribeDocument } from "@/lib/documents/describe";
import { resolveDocumentVisionProvider } from "@/lib/documents/provider-order";
import {
  assertDocumentEgressConsent,
  ConsentRequiredError,
} from "@/lib/ai/consent-guard";
import { reserveBudget } from "@/lib/ai/coach/budget";
import { upsertContentIndex } from "@/lib/documents/content-index";

const PICK = {
  chain: [{ providerType: "anthropic", instance: {} }],
  pick: {
    entry: { providerType: "anthropic", instance: {} },
    providerType: "anthropic",
    pdfSupported: true,
  },
};

const doc = (id: string) => ({
  id,
  kind: "OTHER",
  contentEncrypted: new Uint8Array([1, 2, 3]),
  contentCodec: "binary2",
  mimeType: "image/png",
  status: "STORED",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reserveBudget).mockResolvedValue({
    allowed: true,
    reserved: 1,
  } as never);
  vi.mocked(prisma.inboundDocument.findFirst).mockImplementation(((args: {
    where: { id: string };
  }) => Promise.resolve(doc(args.where.id))) as never);
});

describe("runContentIndexBackfillForUser", () => {
  it("no-ops with no provider", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);
    const result = await runContentIndexBackfillForUser("user-1");
    expect(result).toEqual({
      indexed: 0,
      skipped: 0,
      failed: 0,
      reason: "no-provider",
    });
    expect(upsertContentIndex).not.toHaveBeenCalled();
  });

  it("no-ops when consent is missing", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue(PICK as never);
    vi.mocked(assertDocumentEgressConsent).mockRejectedValueOnce(
      new ConsentRequiredError("insights" as never),
    );
    const result = await runContentIndexBackfillForUser("user-1");
    expect(result).toEqual({
      indexed: 0,
      skipped: 0,
      failed: 0,
      reason: "no-consent",
    });
    expect(upsertContentIndex).not.toHaveBeenCalled();
  });

  it("indexes the not-yet-indexed documents", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue(PICK as never);
    // One short page (< PAGE_SIZE) — the walk breaks after it, so a single
    // findMany return is enough (a trailing once would leak to the next test).
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([
      { id: "d1" },
      { id: "d2" },
    ] as never);

    const result = await runContentIndexBackfillForUser("user-1");
    expect(result).toEqual({
      indexed: 2,
      skipped: 0,
      failed: 0,
      reason: "ok",
    });
    expect(upsertContentIndex).toHaveBeenCalledTimes(2);
  });

  it("includes PDFs as candidates for an image-input provider and rasterises them", async () => {
    // The per-document authority (`prepareVisionInput`) renders a PDF to page
    // images when the provider cannot take PDFs natively. The candidate MIME
    // prefilter must not be stricter than that, or "index all documents"
    // silently leaves every PDF out for exactly those providers.
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [{ providerType: "codex", instance: {} }],
      pick: {
        entry: { providerType: "codex", instance: {} },
        providerType: "codex",
        pdfSupported: false,
      },
    } as never);
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([
      { id: "pdf-1" },
    ] as never);
    vi.mocked(detectOcrMimeType).mockReturnValueOnce(
      "application/pdf" as never,
    );
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: true,
      images: [{ mediaType: "image/png", dataBase64: "cGFnZQ==" }],
    } as never);

    const result = await runContentIndexBackfillForUser("user-1");

    // The discovery walk asked for PDFs despite pdfSupported=false…
    const where = vi.mocked(prisma.inboundDocument.findMany).mock.calls[0]?.[0]
      ?.where as { mimeType: { in: string[] } };
    expect(where.mimeType.in).toContain("application/pdf");
    // …and the document reached `prepareVisionInput`, which rasterised it.
    expect(transcribeDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [{ mediaType: "image/png", dataBase64: "cGFnZQ==" }],
        documents: [],
      }),
    );
    expect(result).toEqual({
      indexed: 1,
      skipped: 0,
      failed: 0,
      reason: "ok",
    });
  });

  it("counts a PDF the rasteriser cannot render as skipped, not failed", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [{ providerType: "codex", instance: {} }],
      pick: {
        entry: { providerType: "codex", instance: {} },
        providerType: "codex",
        pdfSupported: false,
      },
    } as never);
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([
      { id: "pdf-1" },
    ] as never);
    vi.mocked(detectOcrMimeType).mockReturnValueOnce(
      "application/pdf" as never,
    );
    vi.mocked(rasterizePdf).mockResolvedValue({ ok: false } as never);

    const result = await runContentIndexBackfillForUser("user-1");
    // No provider call happened, so this is a skip (retryable later), and the
    // summary says so instead of folding it into silence.
    expect(transcribeDocument).not.toHaveBeenCalled();
    expect(result).toEqual({
      indexed: 0,
      skipped: 1,
      failed: 0,
      reason: "ok",
    });
  });

  it("stops when the daily budget is reached (resumable)", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue(PICK as never);
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValueOnce([
      { id: "d1" },
      { id: "d2" },
    ] as never);
    // First doc gets budget, second is denied → stop before indexing it.
    vi.mocked(reserveBudget)
      .mockReset()
      .mockResolvedValueOnce({ allowed: true, reserved: 1 } as never)
      .mockResolvedValueOnce({ allowed: false, reserved: 0 } as never)
      .mockResolvedValue({ allowed: true, reserved: 1 } as never);

    const result = await runContentIndexBackfillForUser("user-1");
    expect(result).toEqual({
      indexed: 1,
      skipped: 0,
      failed: 0,
      reason: "budget-reached",
    });
    expect(upsertContentIndex).toHaveBeenCalledTimes(1);
  });
});
