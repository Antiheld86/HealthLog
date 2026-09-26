/**
 * The operator switch in front of the HaveIBeenPwned password check.
 *
 * `checkPasswordBreach()` (src/lib/auth/hibp.ts) sends the first five hex
 * characters of the password's SHA-1 to api.pwnedpasswords.com whenever a
 * password is set: registration, a password change, and an admin reset. The
 * range API is k-anonymous, so neither the password nor its full hash leaves
 * the server, but the request itself does, and an instance that promises no
 * third-party calls needs a way to stop it. `PASSWORD_BREACH_CHECK_DISABLED`
 * (1, true, yes or on) turns the check off; the result is then "unknown",
 * which every caller already treats as fail-open.
 *
 * Callers import this module, never `@/lib/auth/hibp` directly;
 * `src/__tests__/password-breach-check-switch.test.ts` holds that line.
 */
import { checkPasswordBreach, type BreachCheckResult } from "@/lib/auth/hibp";
import { envFlag } from "@/lib/env";

export function passwordBreachCheckEnabled(): boolean {
  return !envFlag("PASSWORD_BREACH_CHECK_DISABLED");
}

/** The breach status of `password`, or `null` when disabled or unknown. */
export async function checkPasswordBreachIfEnabled(
  password: string,
): Promise<BreachCheckResult | null> {
  if (!passwordBreachCheckEnabled()) return null;
  return checkPasswordBreach(password);
}
