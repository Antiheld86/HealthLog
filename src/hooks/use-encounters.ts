"use client";

/**
 * Data hooks for visits and the address book behind them.
 *
 * Every value the surfaces render arrives resolved from the server — the
 * practitioner as an object, the links with a label and a date, the
 * appointment's next-due instant computed. Nothing here re-derives one. A
 * client that recomputed a server-side derivation drifts from it the first
 * time the derivation changes on one side only.
 *
 * Writes reach two roots (`encounterDependentKeys`), because renaming a
 * practice changes the label every visit that names it renders.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import {
  encounterDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";
import type { EncounterDTO, EncounterListDTO } from "@/lib/encounters/dto";
import type { EncounterSuggestionResult } from "@/lib/encounters/suggest-window";

export type Encounter = EncounterDTO;
export type EncounterList = EncounterListDTO;

export interface EncounterWriteBody {
  occurredAt?: string;
  status?: "PLANNED" | "DONE" | "CANCELLED" | "NO_SHOW";
  kind?: string;
  practitionerId?: string | null;
  reason?: string | null;
  outcome?: string | null;
  /** The checkup this visit closes, when it was filed from a due one. */
  reminderId?: string | null;
  documentIds?: string[];
  labResultIds?: string[];
  episodeIds?: string[];
}

const BASE = "/api/encounters";

export function useEncounters(
  enabled = true,
  window?: { from?: string; to?: string; status?: string },
) {
  const from = window?.from ?? null;
  const to = window?.to ?? null;
  return useQuery({
    queryKey: queryKeys.encounterList(from, to, window?.status),
    queryFn: () => {
      const sp = new URLSearchParams();
      if (from) sp.set("from", from);
      if (to) sp.set("to", to);
      if (window?.status) sp.set("status", window.status);
      const qs = sp.toString();
      return apiGet<EncounterList>(qs ? `${BASE}?${qs}` : BASE);
    },
    enabled,
  });
}

/** One visit with its three link families resolved. */
export function useEncounter(id: string | null) {
  return useQuery({
    queryKey: queryKeys.encounter(id ?? ""),
    queryFn: () => apiGet<Encounter>(`${BASE}/${id}`),
    enabled: Boolean(id),
  });
}

/**
 * "Does this belong to a visit?" for one anchor date.
 *
 * The verdict is resolved server-side so the document moment and the two lab
 * moments cannot answer the question differently. `anchor` being null means
 * the surface has no date yet and there is nothing to ask about.
 */
export function useEncounterSuggestion(anchor: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.encounterSuggestion(anchor ?? ""),
    queryFn: () =>
      apiGet<EncounterSuggestionResult>(
        `${BASE}/suggest?anchor=${encodeURIComponent(anchor ?? "")}`,
      ),
    enabled: enabled && Boolean(anchor),
  });
}

export function useEncounterMutations() {
  const qc = useQueryClient();
  const invalidate = () => invalidateKeys(qc, encounterDependentKeys);

  const create = useMutation({
    mutationKey: queryKeys.encounterCreate(),
    mutationFn: (body: EncounterWriteBody) => apiPost<Encounter>(BASE, body),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationKey: queryKeys.encounterUpdate(),
    mutationFn: ({ id, body }: { id: string; body: EncounterWriteBody }) =>
      apiPatch<Encounter>(`${BASE}/${id}`, body),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationKey: queryKeys.encounterDelete(),
    mutationFn: (id: string) =>
      apiDelete<{ deleted: boolean }>(`${BASE}/${id}`),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}
