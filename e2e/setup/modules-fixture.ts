/**
 * Fixture for the module-surfaces journey (`e2e/modules-off.spec.ts`).
 *
 * The journey runs on its own account (`E2E_MODULES`). This reads what that
 * account holds straight from Postgres; every WRITE goes through the app
 * (the module switch and the seed rows), so the caches the app keeps are
 * evicted by the app's own paths rather than read stale.
 */
import pg from "pg";

import { E2E_MODULES } from "./global-setup";

/** Rows the journey needs so the surfaces it hides would otherwise paint. */
export interface ModulesSeedState {
  moodEntries: number;
  medications: number;
}

export async function modulesSeedState(): Promise<ModulesSeedState> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[modules-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    const user = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = $1",
      [E2E_MODULES.username],
    );
    const userId = user.rows[0]?.id;
    if (!userId) {
      throw new Error(
        "[modules-fixture] modules account not seeded — global-setup must run first",
      );
    }
    const [mood, meds] = await Promise.all([
      pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM mood_entries WHERE user_id = $1",
        [userId],
      ),
      pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM medications WHERE user_id = $1 AND active = true",
        [userId],
      ),
    ]);
    return {
      moodEntries: Number(mood.rows[0]?.n ?? 0),
      medications: Number(meds.rows[0]?.n ?? 0),
    };
  } finally {
    await pool.end();
  }
}
