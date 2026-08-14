/**
 * v1.18.6 (DISC-02) — the one-time medical-disclaimer acknowledgment version.
 *
 * The user row stores exactly which copy was acknowledged, so a future
 * material wording change can bump this constant to re-prompt. Keep it in lockstep with the
 * `onboarding.disclaimer.*` i18n copy — bump on a substantive text change,
 * not on a typo fix.
 */
export const DISCLAIMER_VERSION = "2026-06-18";

/**
 * Whether a stored acknowledgment covers the CURRENT disclaimer text.
 *
 * The welcome gate pre-checks its checkbox (and skips the re-record) only
 * when this holds. Until v1.37.19 the gate looked at the timestamp alone,
 * which meant the version column was written but never compared — bumping
 * `DISCLAIMER_VERSION` could not re-prompt anyone.
 */
export function isDisclaimerAcknowledgmentCurrent(
  acknowledgedAt: string | Date | null | undefined,
  acknowledgedVersion: string | null | undefined,
): boolean {
  return acknowledgedAt != null && acknowledgedVersion === DISCLAIMER_VERSION;
}
