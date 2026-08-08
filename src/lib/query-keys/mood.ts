/**
 * Query keys — mood entries, mood analytics, and the tag catalog.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const moodKeys = {
  moodEntries: () => ["mood-entries"] as const,

  /**
   * v1.15.13 — the mood management-list read with its filter + sort +
   * pagination state baked into the key, mirroring `measurementsList`.
   * Rides under the `["mood-entries"]` prefix so `moodDependentKeys`
   * (and a bulk-delete invalidation) reaches every slot.
   */
  moodEntriesList: (params: {
    mood: string | undefined;
    source: string | undefined;
    from: string | undefined;
    to: string | undefined;
    page: number;
    sortBy: string;
    sortDir: string;
  }) =>
    [
      "mood-entries",
      "list",
      params.mood ?? null,
      params.source ?? null,
      params.from ?? null,
      params.to ?? null,
      params.page,
      params.sortBy,
      params.sortDir,
    ] as const,

  /**
   * v1.34.3 — every mood entry logged on ONE local day, read by the
   * workout detail page's day context. Rides under the `["mood-entries"]`
   * prefix so `moodDependentKeys` reaches it on a mood write, and carries
   * its own `"day"` scope segment so it can never share a slot with
   * `moodEntriesList` — same key with a different response shape silently
   * poisons the cache.
   */
  moodEntriesDay: (date: string) => ["mood-entries", "day", date] as const,

  /**
   * v1.38 — what the sleep, activity, vitals and illness modules already know
   * about one local day, read by the mood capture sheet and the entry detail.
   *
   * Keyed by the day AND the zone: the same calendar date read under two
   * timezones covers two different windows, and one key for both would serve
   * whichever answer arrived first.
   *
   * Its own prefix rather than a segment under `["mood-entries"]`, and
   * deliberately: nothing here comes from a mood row, so a mood write has no
   * reason to invalidate it, and putting it under that prefix would refetch
   * four modules' figures every time somebody tapped a face.
   */
  moodLinkedContext: (date: string, tz: string) =>
    ["mood-linked-context", date, tz] as const,

  /**
   * v1.38 — the day's two readings: the person's own rating and what their
   * past days imply, with the band and the case count.
   *
   * Under the `["mood-entries"]` prefix so `moodDependentKeys` reaches it: the
   * self-assessment half of the payload comes straight off a mood row, and an
   * edit to today's entry changes the deviation the card shows. The forecast
   * half does not move until the nightly job runs again, which is why the read
   * is cheap enough to refetch on a mood write.
   */
  moodPrognosis: () => ["mood-entries", "prognosis"] as const,

  moodAnalytics: () => ["mood-analytics"] as const,
  /**
   * v1.8.5 — pre-computed mood-insights aggregates (heatmap, distribution,
   * weekday, tag breakdown, cross-metric correlations) for the Mood
   * Insights page. Read-only; invalidated on a mood write through the
   * `moodDependentKeys` fan-out in `./index.ts`.
   */
  moodInsights: () => ["mood-insights"] as const,
  /**
   * v1.8.5 — structured mood-tag taxonomy catalog (global reference
   * data, identical for every user). Read by the mood-logging form's
   * tag-category capture surface. Not invalidated on a mood write — the
   * catalog only changes on a migration / admin edit, so a long
   * `staleTime` is fine.
   */
  moodTagCatalog: () => ["mood-tag-catalog"] as const,
  /**
   * v1.17 — the tag-MANAGEMENT read (`/api/mood/tags?include=
   * hidden,archived,usage`). Rides under the `["mood-tag-catalog"]`
   * prefix so one `invalidateQueries({ queryKey: ["mood-tag-catalog"] })`
   * after any management mutation refreshes both this read and the
   * picker read above (same trick as `moodEntriesList` under
   * `["mood-entries"]`). The scope segment keeps the two queryFn shapes
   * on different keys — same-key/different-shape silently poisons the
   * cache.
   */
  moodTagManage: () => ["mood-tag-catalog", "manage"] as const,
  /**
   * v1.17 — the per-user picker layout blob (`/api/mood/tags/layout`):
   * group order + per-group tag placement. Its own root key — layout
   * writes invalidate it alongside the catalog prefix.
   */
  moodTagLayout: () => ["mood-tag-layout"] as const,
};
