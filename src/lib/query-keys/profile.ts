/** Query keys for the bounded, read-only profile summary surface. */
export const profileKeys = {
  profileSummary: () => ["profile", "summary"] as const,
  /** Emergency ("Notfalldaten") profile (`GET`/`PATCH /api/anamnesis/emergency`). */
  emergencyProfile: () => ["emergency-profile"] as const,
};
