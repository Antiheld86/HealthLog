import { expect, test } from "./setup/test";
import pg from "pg";

import { E2E_USER, STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.31.0 — Today reacts in place.
 *
 * The milestone's actual moment: new data lands, and the ALREADY-OPEN
 * dashboard starts reading differently on the cadence it already runs. No new
 * poll, no push, no socket — a state change, not a notification.
 *
 * The spec drives that end-to-end against the real read path:
 *
 *   1. load the dashboard with last night's sleep still missing;
 *   2. land it through the REAL batch endpoint, and the arrival marker the
 *      spine's worker would have written;
 *   3. surface the tab's real visibility-change signal — the browser event
 *      TanStack Query's focus manager consumes for
 *      `refetchOnWindowFocus: "always"` (alongside the 120 s foreground poll);
 *      using that existing trigger keeps the test inside the real cadence
 *      while staying well under the poll interval;
 *   4. assert the phase flipped and the pending note cleared — in place, no
 *      reload.
 *
 * The hero used to carry a "just in" chip here; it is gone, because under a
 * number "just in" never said what had arrived. What the milestone was
 * always about survives it: the open page reads differently on its own
 * cadence.
 *
 * The marker is seeded directly rather than waited for from pg-boss: whether
 * the queue drains inside the e2e web server is the SPINE's contract and has
 * its own tests. What this spec owns is everything downstream of a marker
 * existing — the read path, the DTO, and the surface.
 *
 * Assertions anchor on `data-slot` / `data-phase`, never on visible text:
 * responsive `sm:hidden` classes have broken `getByText` in this repo before.
 */
test.use({ storageState: STORAGE_STATE_PATH });

/** The user's local day, in the same profile-tz space the digest files under. */
function localDayKey(at: Date, timeZone: string): string {
  // en-CA renders ISO-ordered YYYY-MM-DD, which is exactly the key shape.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

test("a fresh arrival flips the day in place", async ({ page }) => {
  const dbUrl = process.env.DATABASE_URL;
  test.skip(!dbUrl, "DATABASE_URL is required to seed the arrival marker");

  const pool = new pg.Pool({ connectionString: dbUrl });
  const client = await pool.connect();

  try {
    // Both Playwright projects deliberately exercise this real-data flow, but
    // they share the one authenticated fixture user. Keep the two viewport
    // runs from deleting/inserting the same arrival marker concurrently; the
    // lock is scoped to this database session and releases even if the test
    // fails. This preserves real Desktop + Mobile coverage instead of hiding
    // the race behind a project skip.
    await client.query(
      "SELECT pg_advisory_lock(hashtext('e2e:today-just-in'))",
    );

    const { rows } = await client.query<{
      id: string;
      timezone: string | null;
    }>("SELECT id, timezone FROM users WHERE username = $1", [
      E2E_USER.username,
    ]);
    expect(rows.length, "seeded e2e user must exist").toBe(1);
    const userId = rows[0].id;
    const timezone = rows[0].timezone ?? "UTC";

    // A clean reaction slate: no marker and no final morning-refresh stamp.
    // Older health data may remain, but it must not masquerade as newly
    // arrived data before this scenario records its own sleep sample.
    await client.query("DELETE FROM arrival_reactions WHERE user_id = $1", [
      userId,
    ]);
    await client.query(
      "UPDATE users SET morning_digest_refreshed_on = NULL WHERE id = $1",
      [userId],
    );

    // ── BEFORE ────────────────────────────────────────────────────────────
    // Wait until the digest settles. Other browser specs deliberately reuse
    // this account and may have recorded older health data already, so an
    // ordinary briefing hero is a valid baseline. Nothing on it may name an
    // arrival: that chip was removed.
    await page.goto("/");
    await expect(page.locator('[data-slot="today-hero-skeleton"]')).toHaveCount(
      0,
    );
    const hero = page.locator('[data-slot="today-hero"]');
    await expect(page.locator('[data-slot="today-hero-just-in"]')).toHaveCount(
      0,
    );

    // ── NEW DATA LANDS ────────────────────────────────────────────────────
    // Last night's sleep through the real ingest route, on the session the
    // storage state already carries.
    const now = new Date();
    const wokeAt = new Date(now.getTime() - 60 * 60_000);
    const fellAsleepAt = new Date(wokeAt.getTime() - 7 * 60 * 60_000);

    const batch = await page.request.post("/api/measurements/batch", {
      data: {
        entries: [
          {
            hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
            value: 420,
            unit: "min",
            startDate: fellAsleepAt.toISOString(),
            endDate: wokeAt.toISOString(),
            externalId: `e2e-just-in-${now.getTime()}`,
            sleepStage: 3,
          },
        ],
      },
    });
    expect(
      batch.ok(),
      `sleep batch must be accepted (got ${batch.status()})`,
    ).toBe(true);

    // The marker the spine's worker writes on a salient arrival, plus the
    // morning-refresh stamp it rides alongside — the two rows that together
    // make the day final and the arrival news.
    const localDate = localDayKey(now, timezone);
    await client.query(
      `INSERT INTO arrival_reactions
         (id, user_id, kind, local_date, occurred_at, arrived_at, created_at)
       VALUES ($1, $2, 'sleep_night', $3, $4, NOW(), NOW())
       ON CONFLICT (user_id, kind, local_date) DO UPDATE
         SET occurred_at = EXCLUDED.occurred_at,
             arrived_at = NOW()`,
      [`c${now.getTime()}justin000000`, userId, localDate, wokeAt],
    );
    await client.query(
      "UPDATE users SET morning_digest_refreshed_on = $2 WHERE id = $1",
      [userId, localDate],
    );

    // The tab becomes visible — the browser signal TanStack Query's focus
    // manager consumes. The digest refetches in place; the page never reloads.
    await page.evaluate(() =>
      window.dispatchEvent(new Event("visibilitychange")),
    );

    await expect(hero).toHaveAttribute("data-phase", "final", {
      timeout: 20_000,
    });
    // Sleep is in, so the provisional freshness note is gone with it.
    await expect(
      hero.locator('[data-slot="today-hero-sleep-pending"]'),
    ).toHaveCount(0);
    // And the arrival still raises no chip of its own, on either pass.
    await expect(page.locator('[data-slot="today-hero-just-in"]')).toHaveCount(
      0,
    );
  } finally {
    client.release();
    await pool.end();
  }
});
