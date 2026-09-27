/**
 * A browser session whose sign-in is older than the recent-proof window.
 *
 * Exports of the whole record, share links, token minting and connecting an
 * assistant ask for a sign-in or re-proof within five minutes. The shared jar
 * every authenticated spec reads is minted once, in global setup, so whether a
 * spec meets that gate depends on how far into the run it happens to start:
 * early it passes untouched, a few minutes later the web opens the re-proof
 * dialog. A spec that assumes either one is timing-dependent.
 *
 * `useStaleSession` removes the timing. It inserts a session row of its own
 * for the account, signed in ten minutes ago and never re-proved, and points
 * the page's session cookie at it. The row belongs to this one test, so a
 * re-proof in a spec running in the other worker cannot make it fresh, and its
 * own re-proof cannot make the shared session fresh for anyone else. The
 * returned function removes the row.
 *
 * The cookie secret is hashed the way the server hashes it (HMAC-SHA256 under
 * `API_TOKEN_HMAC_KEY`); the web server inherits the runner's environment, so
 * both sides hold the same key.
 */
import { createHmac, randomBytes } from "node:crypto";

import type { Page } from "@playwright/test";
import pg from "pg";

import { expect } from "./test";

const SESSION_COOKIE = "healthlog_session";

/** Older than the five-minute recent-proof window, with room for a slow run. */
const STALE_SIGN_IN_MINUTES = 10;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`[recent-proof] ${name} is not set`);
  return value;
}

export async function useStaleSession(
  page: Page,
  username: string,
): Promise<() => Promise<void>> {
  const secret = `hls_${randomBytes(32).toString("hex")}`;
  const tokenHash = createHmac("sha256", env("API_TOKEN_HMAC_KEY"))
    .update(secret)
    .digest("hex");
  const id = `e2estale${randomBytes(8).toString("hex")}`;

  const pool = new pg.Pool({ connectionString: env("DATABASE_URL") });
  try {
    const inserted = await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
       SELECT $1, id, $2, NOW() + INTERVAL '1 day',
              NOW() - make_interval(mins => $4)
       FROM users WHERE username = $3`,
      [id, tokenHash, username, STALE_SIGN_IN_MINUTES],
    );
    if ((inserted.rowCount ?? 0) !== 1) {
      throw new Error(`[recent-proof] no account named ${username}`);
    }
  } finally {
    await pool.end();
  }

  // Replace the jar's session cookie in place: same name, domain and path, so
  // the browser holds exactly one and cannot send the shared one alongside.
  const context = page.context();
  const current = (await context.cookies()).filter(
    (cookie) => cookie.name === SESSION_COOKIE,
  );
  if (current.length === 0) {
    throw new Error("[recent-proof] the page carries no session cookie");
  }
  await context.addCookies(
    current.map((cookie) => ({ ...cookie, value: secret })),
  );

  return async () => {
    const cleanup = new pg.Pool({ connectionString: env("DATABASE_URL") });
    try {
      await cleanup.query(`DELETE FROM sessions WHERE id = $1`, [id]);
    } finally {
      await cleanup.end();
    }
  };
}

/**
 * Answer the re-proof dialog with the account's password, the way a person
 * does, and wait for it to close. The action behind it is retried by the page.
 */
export async function completeReproofWithPassword(
  page: Page,
  password: string,
): Promise<void> {
  const dialog = page.getByTestId("factor-reauth-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("factor-reauth-password").fill(password);
  await dialog.getByTestId("factor-reauth-submit").click();
  await expect(dialog).toBeHidden();
}
