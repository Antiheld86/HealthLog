/**
 * The immunization-log spec's account hygiene.
 *
 * `vaccinations.spec.ts` asserts GROUPED verdicts — a combination dose appears
 * in each of its three component groups, one antigen holds at most one minted
 * booster reminder, a logged next dose moves the reminder's due date forward.
 * Every one of those is a count over the seeded e2e user's live rows, so the
 * spec has to own the rows it counts against: a dose left by an earlier run, a
 * Playwright retry, or a second project sharing the account would leave a
 * stale group on the page and a second reminder in the antigen bucket, and the
 * grouped assertions would read the wrong count.
 *
 * The reset is delete-then-assert-clean, keyed by the seeded user's id. Links
 * go first for their foreign key; the minted booster reminders go last and are
 * scoped to the ones this feature writes — `vaccination_antigen IS NOT NULL` —
 * so an unrelated Vorsorge reminder another spec relies on is never touched.
 */
import pg from "pg";

import { E2E_USER } from "./global-setup";

async function getUserId(pool: pg.Pool): Promise<string> {
  const res = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE username = $1",
    [E2E_USER.username],
  );
  const id = res.rows[0]?.id;
  if (!id) {
    throw new Error(
      "[vaccination-fixture] e2e user not seeded — global-setup must run first",
    );
  }
  return id;
}

/**
 * Remove the seeded e2e user's vaccination rows, their document links, and the
 * booster reminders they minted. Safe to call from every test's `beforeEach`.
 */
export async function resetVaccinations(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[vaccination-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    const userId = await getUserId(pool);
    // Links first — they FK into the record rows.
    await pool.query(
      "DELETE FROM vaccination_document_links WHERE user_id = $1",
      [userId],
    );
    await pool.query("DELETE FROM vaccination_records WHERE user_id = $1", [
      userId,
    ]);
    // Only the reminders this feature mints. A booster reminder is the only
    // kind that carries an antigen; a checkup another spec created has none and
    // stays.
    await pool.query(
      "DELETE FROM measurement_reminders WHERE user_id = $1 AND vaccination_antigen IS NOT NULL",
      [userId],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Put the seeded e2e user's `vaccinations` module back to its default-on state.
 *
 * The module-off test flips the toggle through the real settings UI, and that
 * write persists on the shared account past the test that made it. Every other
 * flow needs the surface reachable, so this clears the `vaccinations` key from
 * the preferences blob — default-on is absence — leaving any other module the
 * account carries (`nutrients`) untouched. Called from `beforeEach` so no test
 * order can strand the surface off.
 */
export async function ensureVaccinationsModuleOn(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[vaccination-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    const userId = await getUserId(pool);
    await pool.query(
      "UPDATE users SET module_preferences_json = module_preferences_json - 'vaccinations' WHERE id = $1 AND module_preferences_json ? 'vaccinations'",
      [userId],
    );
  } finally {
    await pool.end();
  }
}
