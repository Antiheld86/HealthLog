/**
 * v1.36.0 — the account-grant state machine. One file, one set of rules.
 *
 * A grant is one account's standing permission to read another account's
 * record, and since v1.36.x to add to it as well, and the row is also the
 * durable record of the consent that created it (there is no second receipt
 * table — see the model docblock in `prisma/schema.prisma`). Everything that
 * decides what a grant currently MEANS lives here, and nothing else in the
 * tree is allowed to decide it.
 *
 * Why one file rather than the rules at the call sites: two consumers read
 * these rows for different reasons — the acting-account resolver on every
 * request, and the grant CRUD surface when a person invites, accepts, revokes
 * or renounces. If each carried its own idea of "active", the two would drift,
 * and the drift would be silent in exactly one direction: the resolver
 * admitting a grant the panel shows as ended. The Bearer-token resolver lives
 * in one file for the same reason, and this module is shaped like it.
 * (Naming that function here in prose is what trips the frozen-resolver guard
 * in `src/__tests__/bearer-scope-enforcement-guard.test.ts`, which matches
 * source text and does not exempt comments. Left as it is: a guard over the
 * Bearer perimeter that shouts at a mention is the right direction to be
 * wrong in.)
 *
 * Four properties are the whole point, and each is a decision made HERE and
 * nowhere else:
 *
 *   * **Pending confers nothing.** An invitation is not access. A row with
 *     `acceptedAt IS NULL` fails {@link isGrantActive} — being handed read
 *     access to someone's health record is not something to impose silently.
 *   * **Expiry is live.** The check runs against the clock on the request that
 *     reads the row, not against a sweep that may not have run. A grant a
 *     second past `expiresAt` is already inert.
 *   * **Revocation never deletes.** {@link revokeGrant} and
 *     {@link renounceGrant} stamp `revokedAt` + `revokedBy` on a row that
 *     stays. A deleted row cannot answer "who had access, from when to when,
 *     and who ended it", and that question is the reason the table exists in
 *     the shape it does. Re-inviting the same person mints a NEW row; the
 *     partial unique index in migration 0292 keeps at most one LIVE row per
 *     pair while the history piles up underneath.
 *   * **The level never widens.** A row is READ or WRITE from the moment it is
 *     offered, and no transition here raises it. Widening a grant somebody has
 *     already accepted would change what they agreed to without asking them
 *     again, and the delegate's consent is half of what makes a write grant
 *     legitimate. {@link inviteGrant} carries the reasoning.
 *
 * Every write below is a CONDITIONAL update — the state the transition
 * requires is in the `where`, not in a read the caller performed a moment
 * earlier. Two concurrent accepts therefore cannot both win, and a revoke that
 * lands between a caller's read and its write cannot be overwritten by a
 * transition computed against the stale row.
 */
import { prisma } from "@/lib/db";
import { isP2002 } from "@/lib/prisma-errors";
import { clearActingSessions } from "@/lib/sharing/acting-session";
import type {
  AccountGrant,
  AccountGrantAccess,
  Prisma,
} from "@/generated/prisma/client";

/** The slice of a grant row the pure predicates read. */
export interface GrantLifecycle {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

/**
 * What a grant currently is.
 *
 * Ordering matters and is stated rather than left to the reader: a revoked
 * grant reads REVOKED even if it also sat past its expiry, because somebody
 * ended it and the record should say so. An invitation past its expiry reads
 * EXPIRED rather than PENDING, because it can no longer be accepted. Only
 * ACTIVE confers anything.
 */
export type GrantState = "REVOKED" | "EXPIRED" | "PENDING" | "ACTIVE";

/** What a caller needs the grant to permit. */
export type GrantNeed = "read" | "write";

export type GrantErrorCode =
  /** An account cannot share its record with itself. */
  | "self_grant"
  /** A live grant for this (owner, delegate) pair already exists. */
  | "duplicate_live_grant"
  /** No grant with that id. */
  | "not_found"
  /** The caller is not the delegate this grant names. */
  | "not_grantee"
  /** The caller is not the owner this grant names. */
  | "not_grantor"
  /** Accept ran against a grant that is not pending (already accepted). */
  | "not_pending"
  /** Accept ran against an invitation that had already lapsed. */
  | "expired"
  /** Revoke or renounce ran against a grant that was already ended. */
  | "already_revoked";

/**
 * A refused transition, with a stable code.
 *
 * Codes rather than prose because the two consumers map them to different
 * things — an HTTP status on the CRUD surface, an audit reason in the
 * resolver — and neither should be parsing a sentence.
 */
export class GrantError extends Error {
  constructor(readonly code: GrantErrorCode) {
    super(`account grant refused: ${code}`);
    this.name = "GrantError";
  }
}

/**
 * The narrow client slice these functions need, so a caller can pass a
 * transaction handle. Same shape as `issue-token.ts`.
 */
type GrantDb = Pick<Prisma.TransactionClient, "accountGrant">;

// ── The state machine, pure ─────────────────────────────────────────────────

/** What this grant is, at `now`. */
export function grantState(
  grant: GrantLifecycle,
  now: Date = new Date(),
): GrantState {
  if (grant.revokedAt !== null) return "REVOKED";
  // `<=` matches the Bearer-token expiry comparison: the instant named is the
  // first instant the grant no longer holds.
  if (grant.expiresAt !== null && grant.expiresAt <= now) return "EXPIRED";
  if (grant.acceptedAt === null) return "PENDING";
  return "ACTIVE";
}

/**
 * Does this grant confer anything right now?
 *
 * The one predicate the resolver asks. Deliberately derived from
 * {@link grantState} rather than re-listing the conditions, so a fourth
 * terminal state can never be added without this answering for it.
 */
export function isGrantActive(
  grant: GrantLifecycle,
  now: Date = new Date(),
): boolean {
  return grantState(grant, now) === "ACTIVE";
}

/**
 * Does this grant permit what the caller is about to do?
 *
 * Active first, then the level. A READ grant permits reads only; a WRITE grant
 * permits both, because write access to a record without read access describes
 * nothing anyone asked for. The state outranks the level in both directions: a
 * revoked WRITE grant permits nothing at all, and no level survives an expiry.
 */
export function grantAllows(
  grant: GrantLifecycle & { access: AccountGrantAccess },
  need: GrantNeed,
  now: Date = new Date(),
): boolean {
  if (!isGrantActive(grant, now)) return false;
  return need === "read" ? true : grant.access === "WRITE";
}

// ── Lifecycle transitions ───────────────────────────────────────────────────

export interface InviteGrantInput {
  /** The account whose record is being shared. */
  grantorId: string;
  /** The account being invited to read it. */
  granteeId: string;
  /**
   * What the invitation offers. Required, with no default in this module: a
   * level nobody named is a level nobody chose, and the one place an omitted
   * request field becomes READ is the invite schema
   * (`src/lib/validations/account-sharing.ts`). Two defaults agreeing today is
   * how they disagree later.
   */
  access: AccountGrantAccess;
  /** Optional lapse date. Null = the grant runs until somebody ends it. */
  expiresAt?: Date | null;
}

/**
 * Offer a grant. The delegate has access only once they accept it.
 *
 * The level is fixed here and never moves. There is no widen, no PATCH, no
 * upgrade endpoint, and the absence is the design rather than a gap: write
 * access needs two consents, the owner's because it is their record and the
 * delegate's because they are being asked to put something into somebody's
 * health record under their own name. Acceptance is the single moment those
 * two meet, and it happens once. Raising a live grant afterwards would carry
 * one consent, and it would not be the delegate's. The way up is a new
 * invitation at the level meant, accepted again — the partial unique index
 * permits it as soon as the old row is ended, and the cost is one revoke and
 * one accept.
 *
 * Self-grants are refused here rather than by a database CHECK — migration
 * 0292 carries the reason (the schema-driven wipe seeder plants a row with
 * grantor = grantee by construction). The refusal is therefore load-bearing:
 * it is the only thing standing between the app and a nonsense row.
 */
export async function inviteGrant(
  input: InviteGrantInput,
  db: GrantDb = prisma,
): Promise<AccountGrant> {
  if (input.grantorId === input.granteeId) {
    throw new GrantError("self_grant");
  }

  const now = new Date();
  try {
    return await db.accountGrant.create({
      data: {
        grantorId: input.grantorId,
        granteeId: input.granteeId,
        access: input.access,
        invitedAt: now,
        expiresAt: input.expiresAt ?? null,
      },
    });
  } catch (err) {
    // The partial unique index is what refuses a second live grant for the
    // pair; a revoked row never collides, so a re-invitation after revocation
    // lands as a new row and the old one keeps its history.
    if (isP2002(err)) throw new GrantError("duplicate_live_grant");
    throw err;
  }
}

export interface AcceptGrantInput {
  grantId: string;
  /** Taken from the authenticated session — never from a request body. */
  granteeId: string;
}

/**
 * Accept an invitation. Delegate-only, one-shot.
 *
 * The claim is the `where` clause: `acceptedAt: null` means two concurrent
 * accepts cannot both update a row, and a grant the owner revoked in the
 * meantime cannot be accepted at all. On a miss the row is read back once to
 * say WHY, which is a diagnosis and never a second chance.
 */
export async function acceptGrant(
  input: AcceptGrantInput,
  db: GrantDb = prisma,
): Promise<AccountGrant> {
  const now = new Date();
  const { count } = await db.accountGrant.updateMany({
    where: {
      id: input.grantId,
      granteeId: input.granteeId,
      acceptedAt: null,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    data: { acceptedAt: now },
  });

  if (count === 0) {
    throw await refusalFor(input.grantId, { granteeId: input.granteeId }, db);
  }

  return db.accountGrant.findUniqueOrThrow({ where: { id: input.grantId } });
}

export interface RevokeGrantInput {
  grantId: string;
  /** The owner ending their own grant. Taken from the session. */
  grantorId: string;
}

/**
 * The owner withdraws access.
 *
 * No step-up, no friction: reducing access must never be harder than granting
 * it. The row survives with `revokedBy = GRANTOR`, and because the resolver
 * re-reads the grant on every request, enforcement is the delegate's next
 * request rather than their next login.
 */
export async function revokeGrant(
  input: RevokeGrantInput,
  db: GrantDb = prisma,
): Promise<AccountGrant> {
  return endGrant(input.grantId, { grantorId: input.grantorId }, "GRANTOR", db);
}

export interface RenounceGrantInput {
  grantId: string;
  /** The delegate handing the access back. Taken from the session. */
  granteeId: string;
}

/**
 * The delegate hands the access back.
 *
 * Same transition, different attribution: `revokedBy = GRANTEE` so the record
 * can tell "the owner withdrew it" from "the person given access no longer
 * wanted it". Two facts, one column, because they are answers to the same
 * question.
 */
export async function renounceGrant(
  input: RenounceGrantInput,
  db: GrantDb = prisma,
): Promise<AccountGrant> {
  return endGrant(input.grantId, { granteeId: input.granteeId }, "GRANTEE", db);
}

/**
 * What ending a grant did: the row as it now stands, and how many of the
 * delegate's browser sessions were sitting inside the record when it happened.
 */
export interface EndedGrant {
  grant: AccountGrant;
  sessionsCleared: number;
}

/**
 * The owner withdraws access, and any browser already inside the record leaves
 * with it.
 *
 * This is the verb the sharing panel calls; {@link revokeGrant} is the state
 * transition underneath it. They are separate because the transition has to be
 * usable inside somebody else's transaction, and because a caller who takes the
 * transition alone should have to notice they are leaving sessions behind.
 *
 * One transaction, and the reason is a specific failure: the grant row and the
 * sessions pointing at it are two statements of the same fact, and a revocation
 * that stamped the row but not the sessions would leave the delegate's browser
 * inside a record it can no longer read — every request 403, the banner still
 * saying "viewing her record", nothing on screen able to account for it. The
 * resolver would refuse correctly and the person would still be looking at a
 * lie.
 *
 * Still no step-up, no confirmation ceremony, nothing that makes this slower
 * than granting was. Reducing access must never be harder than giving it: the
 * person ending access to their own health record is the one party here whose
 * intent needs no verification.
 */
export async function revokeGrantAndClearSwitch(
  input: RevokeGrantInput,
): Promise<EndedGrant> {
  return endAndClear((tx) => revokeGrant(input, tx));
}

/**
 * The delegate hands the access back, and their own browser leaves the record.
 *
 * Same cleanup, and for a sharper reason than on the revoke side: the session
 * being cleared is almost certainly the one making this very request, because
 * renouncing is a thing people do while looking at the record they are
 * renouncing.
 */
export async function renounceGrantAndClearSwitch(
  input: RenounceGrantInput,
): Promise<EndedGrant> {
  return endAndClear((tx) => renounceGrant(input, tx));
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * The grant that lets `granteeId` act on `grantorId`'s record right now, or
 * null.
 *
 * The query narrows on `revokedAt: null` only — which the partial unique index
 * makes at most one row — and every other condition is decided by
 * {@link isGrantActive}. That split is deliberate: a SQL predicate spelling out
 * "accepted and not expired" beside a TypeScript predicate spelling out the
 * same thing is two places deciding one question, and the copy that drifts is
 * the one nobody reads. Here the database narrows and the state machine
 * decides.
 */
export async function findActiveGrant(
  pair: { grantorId: string; granteeId: string },
  db: GrantDb = prisma,
  now: Date = new Date(),
): Promise<AccountGrant | null> {
  const live = await db.accountGrant.findFirst({
    where: {
      grantorId: pair.grantorId,
      granteeId: pair.granteeId,
      revokedAt: null,
    },
  });
  if (!live) return null;
  return isGrantActive(live, now) ? live : null;
}

/**
 * Stamp `lastUsedAt` on a grant that was just exercised.
 *
 * Fire-and-forget, the `ApiToken.lastUsedAt` posture (`bearer.ts`): the request
 * that triggered it must not wait, and a failure to record the use must not
 * fail the read. The promise is returned so a test can await it; production
 * callers deliberately do not.
 */
export function touchGrantUsage(
  grantId: string,
  db: GrantDb = prisma,
): Promise<void> {
  return db.accountGrant
    .update({ where: { id: grantId }, data: { lastUsedAt: new Date() } })
    .then(() => undefined)
    .catch(() => undefined);
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * Run an ending transition and its session cleanup as one unit.
 *
 * The transition runs first and throws on a refusal, which rolls the whole
 * thing back — so a revoke somebody was not entitled to make cannot clear a
 * session as a side effect of being refused.
 */
async function endAndClear(
  transition: (tx: Prisma.TransactionClient) => Promise<AccountGrant>,
): Promise<EndedGrant> {
  return prisma.$transaction(async (tx) => {
    const grant = await transition(tx);
    const sessionsCleared = await clearActingSessions(
      { grantorId: grant.grantorId, granteeId: grant.granteeId },
      tx,
    );
    return { grant, sessionsCleared };
  });
}

/** The shared body of revoke and renounce. */
async function endGrant(
  grantId: string,
  actor: { grantorId: string } | { granteeId: string },
  revokedBy: "GRANTOR" | "GRANTEE",
  db: GrantDb,
): Promise<AccountGrant> {
  const { count } = await db.accountGrant.updateMany({
    where: { id: grantId, ...actor, revokedAt: null },
    data: { revokedAt: new Date(), revokedBy },
  });

  if (count === 0) throw await refusalFor(grantId, actor, db);

  return db.accountGrant.findUniqueOrThrow({ where: { id: grantId } });
}

/**
 * Why did a conditional update match nothing?
 *
 * Read once, after the fact, purely to name the refusal. The ordering is
 * ownership first: telling a stranger "that grant is already revoked" would
 * confirm the grant exists, so a caller who is not a party to the row learns
 * only that it is not theirs.
 */
async function refusalFor(
  grantId: string,
  actor: { grantorId: string } | { granteeId: string },
  db: GrantDb,
): Promise<GrantError> {
  const grant = await db.accountGrant.findUnique({ where: { id: grantId } });
  if (!grant) return new GrantError("not_found");

  if ("granteeId" in actor) {
    if (grant.granteeId !== actor.granteeId) {
      return new GrantError("not_grantee");
    }
  } else if (grant.grantorId !== actor.grantorId) {
    return new GrantError("not_grantor");
  }

  // The state machine names the refusal, so "why did this fail" and "what is
  // this row" can never give different answers.
  switch (grantState(grant)) {
    case "REVOKED":
      return new GrantError("already_revoked");
    case "EXPIRED":
      return new GrantError("expired");
    // Reached only from the accept path — revoke and renounce match any live
    // row, lapsed or not, because ending a grant explicitly is always the
    // owner's or the delegate's to do.
    default:
      return new GrantError("not_pending");
  }
}
