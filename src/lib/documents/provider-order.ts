/**
 * Document-class AI provider resolution (governance fix, oauth-investigation
 * SYNTHESIS §1).
 *
 * A three-audit investigation found that for uploaded medical DOCUMENTS the
 * app-wide provider chain is the wrong default: `codex` (the
 * ChatGPT-subscription OAuth backend) sits at chain priority 1, ahead of BYOK
 * and local, and OpenAI's consumer policy allows training on that content by
 * default. HealthLog is privacy-first, so a scanned discharge letter must NOT
 * default to the train-by-default backend.
 *
 * The fix is scoped to the DOCUMENT class only — Coach / insights keep the
 * cost-first app-wide order untouched. This module reprioritises the resolved
 * provider chain for the vault's AI surfaces (suggest / summary / extract /
 * index / reindex / backfill):
 *
 *   local (no egress) → BYOK no-train API (openai / anthropic) → operator's
 *   admin key → codex (ChatGPT-subscription OAuth) LAST, as an explicit,
 *   consented opt-in.
 *
 * The reorder only decides WHICH configured provider is preferred; it never
 * invents a provider. Egress consent (`assertDocumentEgressConsent`) and the
 * per-egress vendor-blind UI notice sit on top of this order — the reorder
 * keeps codex from being the silent default, the consent gate keeps any
 * external egress from happening without an active receipt.
 */
import { isExternalDocumentEgress } from "@/lib/ai/consent-guard";
import { RASTERIZATION_AVAILABLE } from "@/lib/documents/rasterize-pdf";
import {
  resolveTextProvider,
  resolveVisionProvider,
  type ChainReorder,
  type VisionProviderPick,
} from "@/lib/labs/ocr-capability";
import type {
  DocumentAiCapabilityDto,
  DocumentEgressClass,
} from "@/lib/validations/inbound-documents";

/**
 * Preference rank for a provider when the payload is a DOCUMENT. Lower wins.
 * Local keeps the document on the machine (rank 0); BYOK no-train API keys are
 * next (rank 1, including the user's own OpenAI-compatible gateway); the
 * operator's shared no-train key follows (rank 2); the
 * ChatGPT-subscription OAuth paths are LAST (rank 3) — the user's own `codex`
 * AND the operator's shared `admin-codex`, both train on consumer content by
 * default and cannot be verified opted-out from here.
 */
function documentProviderRank(providerType: string): number {
  switch (providerType) {
    case "local":
      return 0;
    case "openai":
    case "anthropic":
    case "admin-key":
    // The user's own gateway (LiteLLM / OpenRouter / vLLM) is a BYO endpoint
    // under their own contract. It may well be on their own network, but
    // HealthLog cannot tell that from the URL, so it ranks with the BYO API
    // keys rather than with `local` — the conservative side.
    case "openai-compatible":
      return 1;
    case "admin-openai":
      return 2;
    case "codex":
    case "admin-codex":
      return 3;
    default:
      return 2;
  }
}

/**
 * Reorder a resolved chain for the document class: stable sort by
 * `documentProviderRank`, so within a rank tier the user's own chain order is
 * preserved (a stable sort keeps insertion order on ties). Pure — returns a new
 * array, never mutates the input.
 */
export const reorderChainForDocumentClass: ChainReorder = (chain) => {
  return [...chain].sort(
    (a, b) =>
      documentProviderRank(a.providerType) -
      documentProviderRank(b.providerType),
  );
};

/**
 * Resolve the vision provider for a DOCUMENT read — local-first, codex last.
 * Same shape as `resolveVisionProvider`; the returned `chain` is already in
 * document order and the `pick` is the first vision-capable entry in it.
 */
export function resolveDocumentVisionProvider(
  userId: string,
): Promise<VisionProviderPick> {
  return resolveVisionProvider(userId, {
    reorder: reorderChainForDocumentClass,
  });
}

/**
 * Resolve the text-mode (browser-OCR) structuring provider for a DOCUMENT —
 * local-first, codex last. The `pick` is the first entry of the reordered
 * chain.
 */
export function resolveDocumentTextProvider(userId: string) {
  return resolveTextProvider(userId, {
    reorder: reorderChainForDocumentClass,
  });
}

/**
 * Classify a picked provider's egress for the per-egress UI notice. Vendor-blind
 * by design — "local" (stays on the machine) vs "external" (a third-party AI
 * service); the copy never names a vendor.
 */
export function documentEgressClass(providerType: string): DocumentEgressClass {
  return isExternalDocumentEgress(providerType) ? "external" : "local";
}

/**
 * Resolve the document AI capability for the vault UI. The `mode` /
 * `pdfSupported` / `egress` reflect the DOCUMENT provider order (local-first),
 * so the affordance the UI offers matches exactly what the document routes do.
 */
export async function resolveDocumentAiCapability(
  userId: string,
): Promise<DocumentAiCapabilityDto> {
  const { chain, pick, localOcrEnabled } =
    await resolveDocumentVisionProvider(userId);

  // A vision-capable provider is available — the read runs directly over the
  // stored original. Egress follows the picked provider. PDFs are readable
  // whenever the picked provider natively supports them (Anthropic) OR the
  // server-side rasterizer is available (every other vision provider reads a
  // PDF via rasterized page images), so the UI offers a PDF read on codex too.
  if (pick) {
    return {
      available: true,
      mode: "vision",
      reason: null,
      pdfSupported: pick.pdfSupported || RASTERIZATION_AVAILABLE,
      egress: documentEgressClass(pick.providerType),
    };
  }

  // Nothing configured at all — no read, regardless of the local-OCR toggle.
  if (chain.length === 0) {
    return {
      available: false,
      mode: null,
      reason: "no-provider",
      pdfSupported: false,
      egress: null,
    };
  }

  // A text-only provider is configured. Local OCR runs in the browser and only
  // the extracted text is structured by the first provider in document order.
  if (localOcrEnabled) {
    return {
      available: true,
      mode: "text",
      reason: null,
      pdfSupported: false,
      egress: documentEgressClass(chain[0]!.providerType),
    };
  }

  // A text-only provider is configured but local OCR is not enabled.
  return {
    available: false,
    mode: null,
    reason: "enable-local-ocr",
    pdfSupported: false,
    egress: null,
  };
}
