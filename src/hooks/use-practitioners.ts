"use client";

/**
 * Data hooks for the account's own address book of doctors and practices.
 *
 * The search runs in SQL over the two plaintext columns rather than in the
 * browser over a downloaded list: the columns are plaintext precisely so the
 * picker can search and sort them there, and a client-side filter would need
 * the whole book in memory to do it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import {
  encounterDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";
import type { PractitionerDTO } from "@/lib/practitioners/dto";

export type Practitioner = PractitionerDTO;

export interface PractitionerWriteBody {
  name?: string;
  specialty?: string | null;
  practice?: string | null;
  location?: string | null;
  phone?: string | null;
  note?: string | null;
}

const BASE = "/api/practitioners";

export function usePractitioners(q?: string, enabled = true) {
  const term = q?.trim() || undefined;
  return useQuery({
    queryKey: queryKeys.practitionerList(term),
    queryFn: () =>
      apiGet<Practitioner[]>(
        term ? `${BASE}?q=${encodeURIComponent(term)}` : BASE,
      ),
    enabled,
  });
}

export function usePractitionerMutations() {
  const qc = useQueryClient();
  const invalidate = () => invalidateKeys(qc, encounterDependentKeys);

  const create = useMutation({
    mutationKey: queryKeys.practitionerCreate(),
    mutationFn: (body: PractitionerWriteBody) =>
      apiPost<Practitioner>(BASE, body),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationKey: queryKeys.practitionerUpdate(),
    mutationFn: ({ id, body }: { id: string; body: PractitionerWriteBody }) =>
      apiPatch<Practitioner>(`${BASE}/${id}`, body),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationKey: queryKeys.practitionerDelete(),
    mutationFn: (id: string) =>
      apiDelete<{ deleted: boolean }>(`${BASE}/${id}`),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}
