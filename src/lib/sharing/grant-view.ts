/**
 * v1.36.0 — how a grant row reaches a client.
 *
 * One shape for every sharing route, because five endpoints each shaping the
 * same row their own way is five chances for the panel to render "active" on a
 * row the resolver has already stopped honouring.
 *
 * `state` is the important field and it is not stored anywhere: it comes from
 * `grantState()`, the same function the resolver's own predicate is built on.
 * A serialiser that derived it here from `revokedAt`/`acceptedAt` would be the
 * second decider this feature spends most of its design avoiding — and it
 * would drift in the dangerous direction, showing a grant as ended while the
 * resolver still admitted it, or the reverse.
 *
 * What is NOT published: the other party's e-mail. The owner typed an
 * identifier to invite somebody and does not need it echoed; the delegate
 * never asked for the owner's. Handing every party to a grant a durable
 * address for every other party is reach the grant was never meant to confer.
 */
import { grantState, type GrantState } from "@/lib/sharing/grants";
import type { AccountGrant } from "@/generated/prisma/client";

/** The other party to a grant, as far as anyone is told about them. */
export interface GrantParty {
  id: string;
  username: string;
  displayName: string | null;
}

export interface GrantView {
  id: string;
  /** The account on the other end: the delegate on a given grant, the owner on a received one. */
  account: GrantParty;
  access: AccountGrant["access"];
  state: GrantState;
  invitedAt: string;
  acceptedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: AccountGrant["revokedBy"];
}

/** The columns a party needs, so a caller can `select` exactly them. */
export const GRANT_PARTY_SELECT = {
  id: true,
  username: true,
  displayName: true,
} as const;

export function toGrantView(
  grant: AccountGrant,
  account: GrantParty,
  now: Date = new Date(),
): GrantView {
  return {
    id: grant.id,
    account,
    access: grant.access,
    state: grantState(grant, now),
    invitedAt: grant.invitedAt.toISOString(),
    acceptedAt: grant.acceptedAt?.toISOString() ?? null,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
    revokedAt: grant.revokedAt?.toISOString() ?? null,
    revokedBy: grant.revokedBy,
  };
}
