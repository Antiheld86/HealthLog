"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiPost } from "@/lib/api/api-fetch";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";

/**
 * Grant the consent for reading documents (`ai_extraction`) from the place
 * that needs it.
 *
 * Sending a document, a lab report scan or a typed medication description to
 * an AI service outside this server needs its own receipt. The narrow kind
 * covers exactly that and never the Coach or AI analysis, so asking for it
 * where a document is being read asks for no more than the reader is about to
 * do. The tap on the prompt IS the consent act; the receipt records it with
 * its source, the same way the web settings record a full grant.
 *
 * On success `/api/auth/me` is refetched, because the capabilities it
 * publishes (`documentAi`, `labsOcr`, `medicationExtract`) are what every
 * reading surface renders from.
 */
export function useGrantDocumentReadingConsent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.aiExtractionConsentGrant(),
    mutationFn: async () => {
      const signedAt = new Date().toISOString();
      return apiPost("/api/consent/ai", {
        kind: "ai_extraction",
        signedAt,
        artefact: JSON.stringify({
          source: "web",
          kind: "ai_extraction",
          grantedAt: signedAt,
          note: "In-app affirmative consent to reading documents, granted via the web client.",
        }),
      });
    },
    onSuccess: () => {
      void invalidateKeys(queryClient, aiInputDependentKeys);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.aiConsentReceipt("ai_extraction"),
      });
    },
  });
}
