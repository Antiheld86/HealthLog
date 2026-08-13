"use client";

/**
 * Client hooks for the review-then-confirm chain on a stored document's
 * staged facts — the missing UI leg of the server chain that already existed:
 *
 *   extract (`POST …/extract`, incl. `{ mode: "stored" }` over the document's
 *   own indexed text) → PENDING `ExtractedFact` rows → optional per-fact edit
 *   (`PATCH …/facts/{factId}`, clears `needsReview`) → confirm
 *   (`POST …/confirm`) — the ONLY write into the structured stores.
 *
 * Nothing here commits on its own. The confirm mutation carries the explicit
 * approve/reject decisions the person made; a fact without a decision stays
 * pending on the server.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiPatch, apiPost } from "@/lib/api/api-fetch";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import type {
  ExtractedFactDto,
  InboundDocumentDetailDto,
  InboundFactEdit,
} from "@/lib/validations/inbound-documents";

/** The confirm route's per-batch outcome (per-fact misses never fail it). */
export interface ConfirmFactsResult {
  approved: { factId: string; recordType: string; recordId: string }[];
  rejected: string[];
  needsReview: string[];
  failed: { factId: string; reason: string }[];
}

/**
 * Structure the document's own stored extracted text into staged facts —
 * the manual recovery when the automatic staging run was skipped or failed.
 * Stages PENDING facts only; the review + confirm steps stay mandatory.
 * A provider call is slow, so the request opts out of the 15 s default.
 */
export function useStoredExtract() {
  const queryClient = useQueryClient();
  return useMutation<InboundDocumentDetailDto, Error, { documentId: string }>({
    mutationFn: ({ documentId }) =>
      apiPost<InboundDocumentDetailDto>(
        `/api/documents/inbound/${documentId}/extract`,
        { mode: "stored" },
        { signal: AbortSignal.timeout(120_000) },
      ),
    onSuccess: (_data, { documentId }) => {
      void invalidateKeys(queryClient, [
        queryKeys.inboundDocument(documentId),
        queryKeys.documents(),
      ]);
    },
  });
}

/**
 * Correct a staged fact before approval. A successful edit clears
 * `needsReview` server-side — the values become user-asserted and the fact
 * turns approvable. The fact's resource type can never change.
 */
export function useEditFact() {
  const queryClient = useQueryClient();
  return useMutation<
    ExtractedFactDto,
    Error,
    { documentId: string; factId: string; edit: InboundFactEdit }
  >({
    mutationFn: ({ documentId, factId, edit }) =>
      apiPatch<ExtractedFactDto>(
        `/api/documents/inbound/${documentId}/facts/${factId}`,
        edit,
      ),
    onSuccess: (_data, { documentId }) => {
      void invalidateKeys(queryClient, [queryKeys.inboundDocument(documentId)]);
    },
  });
}

/**
 * Commit the review decisions. Approved facts land in their structured
 * stores (labs / conditions / medications) through the server's existing
 * field-by-field commit; rejected facts are discarded. Invalidates every
 * read the commit can touch, plus the document itself (status + fact states).
 */
export function useConfirmFacts() {
  const queryClient = useQueryClient();
  return useMutation<
    ConfirmFactsResult,
    Error,
    {
      documentId: string;
      decisions: { factId: string; action: "approve" | "reject" }[];
    }
  >({
    mutationFn: ({ documentId, decisions }) =>
      apiPost<ConfirmFactsResult>(
        `/api/documents/inbound/${documentId}/confirm`,
        { decisions },
      ),
    onSuccess: (_data, { documentId }) => {
      void invalidateKeys(queryClient, [
        queryKeys.inboundDocument(documentId),
        queryKeys.documents(),
        queryKeys.labResults(),
        queryKeys.biomarkers(),
        queryKeys.illness(),
        queryKeys.medications(),
      ]);
    },
  });
}
