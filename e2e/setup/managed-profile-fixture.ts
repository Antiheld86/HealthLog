/**
 * v1.37.0 — the step-up the managed-profile journey needs, and nothing else.
 *
 * ## Why a fixture exists at all
 *
 * Every route in the managed-profile family resolves
 * `requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS)`. That gate has two halves:
 * the account must have a second factor enrolled, and the SESSION must carry a
 * `mfaVerifiedAt` newer than five minutes. `global-setup.ts` supplies the first
 * half once; the second cannot be supplied once, because a full suite run takes
 * longer than the window and the journey would be gated on how long the specs
 * ahead of it took.
 *
 * So the freshness stamp is refreshed immediately before the journey acts. It
 * is not a bypass and it does not weaken the route: the route still runs its
 * gate, the session still has to carry a stamp, and a session without one is
 * still refused. What it simulates is the person having just proved their
 * factor — which is the state the product requires and the only state in which
 * this surface is usable at all.
 *
 * Seeded through `pg`, the same transport `global-setup.ts` and
 * `vault-fixture.ts` use, because there is no product endpoint that says "I
 * proved a factor" without a real factor to prove.
 */
import pg from "pg";

import { E2E_GUARDIAN } from "./global-setup";

function connect(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("[managed-profile-fixture] DATABASE_URL is not set");
  }
  return new pg.Pool({ connectionString: url });
}

/**
 * Make the guardian's step-up fresh, and clear anything an earlier run left.
 *
 * Idempotent, and safe to call from a `beforeEach`: both statements are
 * unconditional writes scoped to this one fixture account.
 */
export async function refreshGuardianStepUp(): Promise<void> {
  const pool = connect();
  try {
    const stamped = await pool.query(
      `UPDATE sessions SET mfa_verified_at = NOW()
       WHERE user_id = (SELECT id FROM users WHERE username = $1)`,
      [E2E_GUARDIAN.username],
    );
    // A zero-row update means the jar this journey runs under points at a
    // session that is not there, and every act below would be refused for a
    // reason that has nothing to do with what it tests. Fail loudly here.
    if ((stamped.rowCount ?? 0) === 0) {
      throw new Error(
        `[managed-profile-fixture] no session for ${E2E_GUARDIAN.username}`,
      );
    }
    // And the factor itself, in case a spec ran before global setup stamped it.
    await pool.query(
      `UPDATE users SET totp_confirmed_at = COALESCE(totp_confirmed_at, NOW())
       WHERE username = $1`,
      [E2E_GUARDIAN.username],
    );
    // The guardian-invitation bucket, for the same reason `global-setup.ts`
    // clears the auth bucket between its own logins: the ceiling is ten
    // invitations an hour per caller, and this journey spends one every time it
    // runs. On CI that never matters; locally, the eleventh run inside an hour
    // is answered by the product's own 429 rather than by what the test is
    // about, and the failure reads as a broken invitation form. Only this one
    // fixture account's bucket is touched.
    await pool.query(
      `DELETE FROM rate_limits
       WHERE key = 'managed-profile:guardian-invite:' ||
         (SELECT id FROM users WHERE username = $1)`,
      [E2E_GUARDIAN.username],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Remove every managed profile this account looks after.
 *
 * A managed profile is a real account row, so a journey that created one and
 * left it behind makes the next run's roster assertions read the wrong record.
 * Deleting the profile takes its grants with it.
 */
export async function clearGuardianProfiles(): Promise<void> {
  const pool = connect();
  try {
    await pool.query(
      `DELETE FROM users
       WHERE managed_profile_at IS NOT NULL
         AND id IN (
           SELECT g.grantor_id FROM account_grants g
           JOIN users u ON u.id = g.grantee_id
           WHERE u.username = $1
         )`,
      [E2E_GUARDIAN.username],
    );
  } finally {
    await pool.end();
  }
}
