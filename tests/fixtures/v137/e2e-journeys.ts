/**
 * What a browser has to prove about v1.37 sharing, enumerated.
 *
 * Two lists, and both exist for the same reason: a browser suite reports what
 * it ran, never what it did not. A state nobody wrote a test for and a journey
 * somebody quietly dropped both look like a green run. Naming them in one
 * place that a fast test reads back turns "we cover the error state" from a
 * claim in a summary into something that fails.
 *
 * Nothing here drives a browser. The enumeration is the contract; the spec is
 * the implementation, and `src/__tests__/sharing-accessibility-states.test.ts`
 * is what holds the two together.
 */

/* -------------------------------------------------------------------------- */
/* The five states                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every state a shared-record surface can be in, and all five have to be
 * usable — not merely reachable.
 *
 * Accessibility work concentrates on the state where everything worked,
 * because that is the state somebody building the screen is looking at. The
 * other four are where a person who cannot see the screen is most stranded: a
 * spinner nobody announces, an error card that reads as an empty page, a
 * refusal whose only way out is a button no keyboard reaches.
 */
export const ACCESSIBILITY_STATES = [
  "success",
  "empty",
  "loading",
  "error",
  "refusal",
] as const;

export type AccessibilityState = (typeof ACCESSIBILITY_STATES)[number];

export interface AccessibilityStateCase {
  readonly state: AccessibilityState;
  /**
   * The `data-slot` that proves the state is actually on screen.
   *
   * A scan of a page that never entered the state passes trivially, so every
   * case names the element that says it arrived, and the fast guard checks the
   * component tree really renders that slot.
   */
  readonly anchor: string;
  /** The module that renders {@link anchor}, so a state cannot be invented. */
  readonly rendersIn: string;
  /**
   * The control keyboard focus must reach, or `null` where the state offers
   * none at all. A loading state has nothing to press; every other state here
   * has a way forward, and a way forward a keyboard cannot reach is not one.
   */
  readonly keyboardTarget: string | null;
  /**
   * Copy the person has to read and act on, which must render as content
   * rather than as muted meta (UI-STANDARDS §3). `null` where the state's only
   * text is a screen-reader label, which has no visual contrast to check.
   */
  readonly contrastTarget: string | null;
  /** Why this state is on the list, in one line. */
  readonly claim: string;
}

export const SHARING_ACCESSIBILITY_STATES = [
  {
    state: "success",
    anchor: '[data-slot="profile-summary"]',
    rendersIn: "src/components/records/profile-summary.tsx",
    keyboardTarget: '[data-slot="shared-record-banner-exit"]',
    contrastTarget: '[data-slot="shared-record-banner-context"]',
    claim:
      "inside somebody else's record, the line saying whose it is and the way out are both usable",
  },
  {
    state: "empty",
    anchor: '[data-slot="grants-given-card"] [data-slot="empty-state"]',
    rendersIn: "src/components/ui/empty-state.tsx",
    keyboardTarget: '[data-slot="grant-invite-identifier"]',
    contrastTarget:
      '[data-slot="grants-given-card"] [data-slot="empty-state"] p',
    claim:
      "nothing shared yet reads as an answer rather than as a page that failed to load",
  },
  {
    state: "loading",
    anchor: '[data-slot="record-scope-hydration-gate"]',
    rendersIn: "src/components/layout/record-scope-hydration-gate.tsx",
    keyboardTarget: null,
    contrastTarget: null,
    claim:
      "the hold before the active record is known is announced, not a silent blank",
  },
  {
    state: "error",
    anchor: '[data-slot="query-error-card"]',
    rendersIn: "src/components/ui/query-error-card.tsx",
    keyboardTarget: '[data-slot="query-error-retry"]',
    contrastTarget: '[data-slot="query-error-card"] p',
    claim: "a failed read says so and offers the retry to a keyboard",
  },
  {
    state: "refusal",
    anchor: '[data-slot="shared-record-unavailable"]',
    rendersIn: "src/components/layout/shared-record-unavailable.tsx",
    keyboardTarget: '[data-slot="shared-record-unavailable-leave"]',
    contrastTarget: '[data-slot="shared-record-unavailable"] p',
    claim:
      "a surface sharing does not cover explains itself and keeps a way back to one's own record",
  },
] as const satisfies readonly AccessibilityStateCase[];

/* -------------------------------------------------------------------------- */
/* The eight journeys                                                         */
/* -------------------------------------------------------------------------- */

export interface JourneyClaim {
  /** Stable id, quoted in the spec's test title so the two can be matched. */
  readonly id: string;
  /** What the journey proves, in the release's own words. */
  readonly claim: string;
}

/**
 * The eight end-to-end proofs the release is required to run, transcribed from
 * the phase context rather than restated: a paraphrase is where a requirement
 * quietly narrows.
 *
 * The list is here rather than in a spec file because more than one spec runs
 * parts of it, and because the integration plan reconciles the whole set at
 * the end. An id that no test title mentions is a journey nobody ran.
 */
export const V137_E2E_JOURNEYS = [
  {
    id: "J1-adult-levels-lifecycle",
    claim:
      "Adult full READ, scoped READ, WRITE and MANAGE through invite, accept, switch, expiry, revoke and direct URL.",
  },
  {
    id: "J2-manage-edits-without-settings",
    claim:
      "Adult MANAGE edits and deletes with specific activity, and zero Guardian-only settings or integration reach.",
  },
  {
    id: "J3-managed-profile-lifecycle",
    claim:
      "Truthful managed-profile creation, two Guardians, concurrent last-Guardian protection, record settings and deletion.",
  },
  {
    id: "J4-guardian-notification-matrix",
    claim:
      "Two Guardians by two profiles through APNs, Web Push, Telegram and ntfy with recipient locale and preferences, non-interactive payloads and subject/recipient attempts.",
  },
  {
    id: "J5-revoked-idempotent-replay",
    claim:
      "Revoked MANAGE idempotency replay returns 403, no cached DTO and no second mutation.",
  },
  {
    id: "J6-no-delegated-provider-egress",
    claim:
      "An invited MANAGE mutation with a configured provider produces no provider job or call; the owner positive control enqueues.",
  },
  {
    id: "J7-durable-import-actor",
    claim:
      "Asynchronous import completion retains record, actor and job identity.",
  },
  {
    id: "J8-old-client-compatibility",
    claim:
      "Old-client compatibility preserves legacy decode, scoped fail-closed behaviour and MANAGE decode until the canonical client is ready.",
  },
] as const satisfies readonly JourneyClaim[];
