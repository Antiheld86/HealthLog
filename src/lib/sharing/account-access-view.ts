/**
 * v1.36.0 — the shape of the sharing block, and nothing else.
 *
 * Types only, with no imports at all, because both ends read them: the route
 * that builds the block (`account-access.ts`, which talks to Postgres) and the
 * client that renders it. Declaring them beside the server code would put a
 * module that imports Prisma on the client's import graph — erased at compile
 * today, one careless value export away from being bundled tomorrow. The
 * boundary is cheaper to keep than to rediscover.
 *
 * What these types are FOR is stated once here and holds everywhere they are
 * used: they carry resolved answers. `canWrite` and `canSwitch` are decisions
 * the server has already made; a client that recomputed either from the rest
 * of the payload would be the second program deciding one person's access.
 */

/** One account this caller may act on. */
export interface AccountAccessEntry {
  /** The account whose record it is — the value `POST /api/account/switch` takes. */
  accountId: string;
  username: string;
  displayName: string | null;
  /** The grant's level. `"read"` throughout v1. */
  access: "read" | "write";
  /** May this caller change that record. Resolved server-side; `false` in v1. */
  canWrite: boolean;
}

/** The `accountAccess` block on `GET /api/auth/me`. */
export interface AccountAccess {
  /** Every account this caller may open, newest grant first. */
  accounts: AccountAccessEntry[];
  /**
   * The record this browser is inside right now, resolved to a full entry —
   * not an id the client has to look up. Null when it is in its own record,
   * and always null on the Bearer transport.
   */
  active: AccountAccessEntry | null;
  /** Is there anywhere to switch to. */
  canSwitch: boolean;
}

/**
 * The name to put in front of a person, given what the payload published.
 *
 * `displayName` when the account set one, the username otherwise. This is a
 * presentation fallback and not a derivation of anything the server decided —
 * both values are published, and which of the two reads better is the client's
 * business. Kept here so the banner, the switcher and the sharing panel cannot
 * disagree about what to call somebody.
 */
export function accountLabel(entry: {
  displayName: string | null;
  username: string;
}): string {
  const named = entry.displayName?.trim();
  return named && named.length > 0 ? named : entry.username;
}
