/**
 * Query keys — the immunization log.
 * Part of the centralized factory; aggregated in `./index.ts`.
 *
 * These exist before any client reads them, because the in-repo
 * `healthlog/queryKey-factory` rule errors on a bare array: the first
 * component that lists doses cannot compile without a slot here. Same key with
 * a different `queryFn` shape silently poisons the cache, which is the whole
 * reason the factory is the only legal source.
 *
 * There is deliberately no matching `invalidateUserVaccinations` in
 * `src/lib/cache/invalidate.ts`, for the same reason the visits module next
 * door has none. That module evicts SERVER-side cached payloads, and no cached
 * payload reads a dose: the dashboard snapshot, the insights targets and the
 * analytics buckets are computed from measurements, medications and mood.
 * Adding a sweep over caches nothing reads would be a placeholder that looks
 * like coverage. It belongs in the release that puts doses into one of those
 * payloads, alongside the reader that makes it necessary.
 *
 * The one server-side cache a dose CAN move belongs to somebody else: logging
 * one satisfies a booster reminder, which is a preventive-care write. That
 * eviction is the reminder module's, and the client bundle below invalidates
 * the reminder keys for the same reason.
 */
export const vaccinationKeys = {
  /**
   * The root prefix every dose write invalidates through
   * (`vaccinationDependentKeys` in `./index.ts`). TanStack's hierarchical
   * prefix semantics mean evicting `["vaccinations"]` clears the list and
   * every open detail in one tick, so a dose edited in a sheet and the list
   * behind it never disagree.
   */
  vaccinations: () => ["vaccinations"] as const,
  /**
   * The list. The filter is part of the key: a page showing one antigen's
   * history and the page showing everything are two different answers rather
   * than one answer that overwrites the other.
   */
  vaccinationList: (antigenSlug?: string | null) =>
    ["vaccinations", "list", antigenSlug ?? null] as const,
  vaccination: (id: string) => ["vaccinations", "detail", id] as const,
} as const;
