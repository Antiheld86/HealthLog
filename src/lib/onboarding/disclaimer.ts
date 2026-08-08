/**
 * v1.18.6 (DISC-02) — the one-time medical-disclaimer acknowledgment version.
 *
 * The user row stores exactly which copy was acknowledged, so a future
 * material wording change can bump this constant to re-prompt. Keep it in lockstep with the
 * `onboarding.disclaimer.*` i18n copy — bump on a substantive text change,
 * not on a typo fix.
 */
export const DISCLAIMER_VERSION = "2026-06-18";
