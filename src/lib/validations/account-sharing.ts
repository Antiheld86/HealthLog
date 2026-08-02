/**
 * v1.36.0 — request shapes for the account-sharing lifecycle.
 *
 * Four verbs are exercised through these routes (invite, accept, end, switch)
 * and only two of them carry a body worth validating. What is NOT here is as
 * deliberate as what is:
 *
 *   * No `access` level. v1 grants READ and only READ, and the level is not a
 *     parameter anywhere in the stack — `inviteGrant` hardcodes it. A field
 *     here would be an input the domain module then ignores, which is the
 *     shape of a promise nobody kept.
 *   * No `userId`, `grantorId` or `granteeId` on any body. Both sides of a
 *     grant come from the authenticated session and the row itself. A body
 *     field naming a party would be an authorization decision made by the
 *     caller.
 */
import { z } from "zod/v4";

/**
 * How long a value naming an account may be.
 *
 * Matches the resolver's own selector bound (`MAX_SELECTOR_LENGTH`, 64): ids
 * are 25-character cuids, and a longer string names nothing that could exist.
 */
const MAX_ACCOUNT_ID_LENGTH = 64;

/**
 * An e-mail address or a username, whichever the owner knows the person by.
 *
 * The same identifier the login form accepts, matched the same way (either
 * column, case-insensitively), because asking somebody to invite a housemate
 * by a different name than the one that housemate types to sign in is a
 * support ticket waiting to happen.
 *
 * The 255 bound is the e-mail column's practical ceiling; anything past it is
 * refused before it reaches a query.
 */
export const inviteGrantSchema = z.object({
  identifier: z.string().trim().min(1).max(255),
  /**
   * Optional lapse date. Absent or null means the grant runs until somebody
   * ends it — the common household case, where an expiry the owner has to
   * remember to renew is worse than one that does not exist.
   */
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export type InviteGrantBody = z.infer<typeof inviteGrantSchema>;

/**
 * The switch body. `null` is the whole point of the field rather than an
 * omission: clearing the switch and setting one are the same act pointed in
 * two directions, and a separate "unswitch" route would be a second place to
 * get the session write right.
 */
export const switchAccountSchema = z.object({
  accountId: z.string().min(1).max(MAX_ACCOUNT_ID_LENGTH).nullable(),
});

export type SwitchAccountBody = z.infer<typeof switchAccountSchema>;
