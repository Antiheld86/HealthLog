"use client";

/**
 * The document picker's availability for the person on this screen (#1038).
 *
 * Reads `GET /api/documents/sources` only when it can matter: the documents
 * module is on and the person is in their own record with the right to manage
 * documents. A delegate or guardian never asks (the route would refuse them
 * anyway), so the import buttons and the settings card render nothing for
 * them. `connected` is the list of systems with a usable connection, in a
 * stable order; an entry whose origin the operator removed is left out.
 */
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiGet } from "@/lib/api/api-fetch";
import type {
  DocumentPickerSystem,
  DocumentSourcesStatusDto,
} from "@/lib/documents/sources/types";
import { queryKeys } from "@/lib/query-keys";

export function useDocumentSourcesStatus() {
  const { user } = useAuth();
  const { canManageDomain, inSharedRecord } = useRecordCapabilities();
  const eligible =
    user?.modules?.inboundDocuments === true &&
    !inSharedRecord &&
    canManageDomain("documents");

  const query = useQuery({
    queryKey: queryKeys.documentSourcesStatus(),
    enabled: eligible,
    queryFn: () => apiGet<DocumentSourcesStatusDto>("/api/documents/sources"),
    staleTime: 60_000,
  });

  const connected: DocumentPickerSystem[] = eligible
    ? (query.data?.connections ?? [])
        .filter((c) => c.originAllowed)
        .map((c) => c.system)
    : [];

  return { eligible, query, connected };
}

/** Display name of a system; product names, not translated. */
export function systemName(system: DocumentPickerSystem): string {
  return system === "PAPERLESS" ? "Paperless-ngx" : "Papra";
}
