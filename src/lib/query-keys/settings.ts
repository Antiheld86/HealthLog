/**
 * Query keys — settings + notification surfaces, version/meta reads,
 * gamification, share links, and feature flags.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const settingsKeys = {
  gamificationAchievements: () => ["gamification", "achievements"] as const,

  notificationsPreferences: () => ["notifications", "preferences"] as const,
  notificationsStatus: () => ["notifications", "status"] as const,

  settingsGlobalServices: () => ["settings", "global-services"] as const,
  settingsNtfy: () => ["settings", "ntfy"] as const,
  /** v1.17.1 — generic-webhook channel config. */
  settingsWebhook: () => ["settings", "webhook"] as const,
  /** v1.17.1 — SMTP / email channel config. */
  settingsEmail: () => ["settings", "email"] as const,
  settingsReminderThresholds: () =>
    ["settings", "reminder-thresholds"] as const,

  /** v1.8.5 — user-level injection-site preferences (global exclusion). */
  injectionSitePrefs: () => ["settings", "injection-site-prefs"] as const,

  /**
   * The declared diabetes opt-in behind `GET/PATCH /api/auth/me/diabetes`.
   * Selects which reference band glucose readings are judged against, so the
   * toggle also invalidates `insightsTargets()` — the resolved band rides
   * on that payload.
   */
  diabetesPref: () => ["settings", "diabetes"] as const,

  /**
   * v1.18.0 — the per-user module enable/disable map behind
   * `GET/PATCH /api/auth/me/modules`. Used as the Module-hub mutation key;
   * the resolved map itself rides on `authMe()` (the `/auth/me` payload),
   * so the toggle mutation invalidates `authMe()` to re-gate the nav,
   * Insights pills, and dashboard tiles in lockstep.
   */
  modulesPrefs: () => ["settings", "modules"] as const,

  /**
   * v1.35.0 — which pillars count toward the Health Score, behind
   * `GET/PATCH /api/auth/me/health-score-config`. Its own cell rather than
   * a slice of `authMe()`: the payload carries the optimistic-concurrency
   * token the save echoes, and folding it into the account payload would
   * make every unrelated profile write advance the token.
   */
  healthScoreConfig: () => ["settings", "health-score-config"] as const,

  apiVersion: () => ["api", "version"] as const,
  publicVersion: () => ["public", "version"] as const,
  /** v1.15.12 H1 — admin overview "update available" check against the
   * latest GitHub release tag (best-effort, day-stale). */
  versionUpdateCheck: () => ["version", "update-check"] as const,

  /**
   * v1.23 — the Data & Privacy dashboard's read-only retention + encryption
   * summary behind `GET /api/settings/privacy-summary`.
   */
  privacySummary: () => ["settings", "privacy-summary"] as const,

  /** v1.11.0 — owner's clinician share links (Settings → Sharing). */
  shareLinks: () => ["share-links"] as const,

  featureFlags: () => ["feature-flags"] as const,

  /**
   * The account's standing AI consent receipt (`GET /api/consent/ai/latest`).
   * Keyed by kind because the endpoint answers per kind and a shared key
   * across kinds would serve one kind's receipt for another.
   */
  aiConsentReceipt: (kind: string) =>
    ["consent", "ai", "latest", kind] as const,
};
