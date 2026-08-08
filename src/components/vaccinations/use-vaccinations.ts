"use client";

/**
 * v1.38.0 — immunization-log read hooks.
 *
 * Reads unwrap the envelope `data` (via `apiGet`) per the project rule, and
 * every key is factory-routed through `queryKeys.vaccination*`. The list
 * arrives with each dose's `series` already resolved per component antigen —
 * this client renders text from those numbers and never re-derives "N von M".
 *
 * Writes and the booster mint land with the capture form; they invalidate
 * `vaccinationDependentKeys`, which evicts the preventive-care root alongside
 * the dose list because logging a dose re-anchors the booster it answers.
 */
import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { VaccinationDTO, VaccinationListDTO } from "@/lib/vaccinations/dto";

export type Vaccination = VaccinationDTO;

/**
 * The account's immunization log, newest dose first.
 *
 * `antigenSlug` filters the server query to one antigen's history; the series
 * numbers are still derived over the whole live set on the server, so a
 * filtered view never reports the oldest visible dose as the first ever given.
 */
export function useVaccinations(
  antigenSlug?: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.vaccinationList(antigenSlug ?? null),
    enabled,
    queryFn: () =>
      apiGet<VaccinationListDTO>(
        antigenSlug
          ? `/api/vaccinations?antigenSlug=${encodeURIComponent(antigenSlug)}`
          : "/api/vaccinations",
      ),
  });
}
