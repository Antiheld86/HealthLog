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
 *   1. load the dashboard with nothing fresh — no chip, day is provisional;
 *   2. land last night's sleep through the REAL batch endpoint, and the
 *      arrival marker the spine's worker would have written;
 *   3. surface the tab's real visibility-change signal — the browser event
 *      TanStack Query's focus manager consumes for
 *      `refetchOnWindowFocus: "always"` (alongside the 120 s foreground poll);
 *      using that existing trigger keeps the test inside the real cadence
 *      while staying well under the poll interval;
 *   4. assert the chip appeared and the phase flipped — in place, no reload.
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

test("a fresh arrival surfaces the just-in chip and flips the day in place", async ({
  page,
}) => {
  const dbUrl = process.env.DATABASE_URL;
  test.skip(!dbUrl, "DATABASE_URL is required to seed the arrival marker");

  const pool = new pg.Pool({ connectionString: dbUrl });

  try {
    const { rows } = await pool.query<{ id: string; timezone: string | null }>(
      "SELECT id, timezone FROM users WHERE username = $1",
      [E2E_USER.username],
    );
    expect(rows.length, "seeded e2e user must exist").toBe(1);
    const userId = rows[0].id;
    const timezone = rows[0].timezone ?? "UTC";

    // A clean slate: no marker, and last night's sleep not yet in. Both are
    // preconditions for the "before" assertion to mean anything.
    await pool.query("DELETE FROM arrival_reactions WHERE user_id = $1", [
      userId,
    ]);
    await pool.query(
      "UPDATE users SET morning_digest_refreshed_on = NULL WHERE id = $1",
      [userId],
    );

    // ── BEFORE ────────────────────────────────────────────────────────────
    // The globally-seeded account is intentionally empty. Wait until the
    // digest settles, then prove there is no stale hero or arrival chip.
    await page.goto("/");
    await expect(page.locator('[data-slot="today-hero-skeleton"]')).toHaveCount(
      0,
    );
    const hero = page.locator('[data-slot="today-hero"]');
    await expect(hero).toHaveCount(0);

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
    await pool.query(
      `INSERT INTO arrival_reactions
         (id, user_id, kind, local_date, occurred_at, arrived_at, created_at)
       VALUES ($1, $2, 'sleep_night', $3, $4, NOW(), NOW())
       ON CONFLICT (user_id, kind, local_date) DO UPDATE
         SET occurred_at = EXCLUDED.occurred_at,
             arrived_at = NOW()`,
      [`c${now.getTime()}justin000000`, userId, localDate, wokeAt],
    );
    await pool.query(
      "UPDATE users SET morning_digest_refreshed_on = $2 WHERE id = $1",
      [userId, localDate],
    );

    // The tab becomes visible — the browser signal TanStack Query's focus
    // manager consumes. The digest refetches in place; the page never reloads.
    await page.evaluate(() =>
      window.dispatchEvent(new Event("visibilitychange")),
    );

    await expect(hero.locator('[data-slot="today-hero-just-in"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(hero).toHaveAttribute("data-phase", "final", {
      timeout: 20_000,
    });
    // Sleep is in, so the provisional freshness note is gone with it.
    await expect(
      hero.locator('[data-slot="today-hero-sleep-pending"]'),
    ).toHaveCount(0);
    // The chip names the arrival kind — the stable attribute, not the copy.
    await expect(
      hero.locator('[data-slot="today-hero-just-in"]'),
    ).toHaveAttribute("data-just-in-kind", "sleep_night");
  } finally {
    await pool.end();
  }
});
