/**
 * v1.37.0 — what record a request believes it is addressing, as a contract both
 * bundles can name.
 *
 * The problem is agreement, not authorization. `acting_as_user_id` plus the
 * grant join already decides whether a caller MAY read a record; nothing here
 * touches that. What this decides is whether the record the server is about to
 * serve is the record the client formed its intent against. A browser holds
 * several tabs on one session; a request that left a suspended tab before a
 * switch landed arrives after it, perfectly authorized and asking the wrong
 * question. So every cookie request that resolves a record asserts the context
 * it believes it is in, and the server refuses when the belief no longer
 * matches the session row.
 *
 * ─── Why this module has no imports ───────────────────────────────────────
 *
 * The client has to name the header constants, and both obvious homes poison
 * the client bundle: `src/lib/api-handler.ts` imports Prisma at module scope
 * and `src/lib/auth/acting-carrier.ts` imports `next/headers`. Either import
 * would typecheck cleanly and fail `pnpm build`. So the constants, the parse
 * and the verdict live here with ZERO imports — asserted by the unit test, not
 * by convention — and the server half lives next door in
 * `record-session-fence.ts`.
 *
 * ─── What the fence does NOT cover ────────────────────────────────────────
 *
 * Only the two record resolvers (`requireRecordAuth`, `requireGuardianAuth`)
 * and the idempotency wrapper consult it. `requireActorAuth`, bare
 * `requireAuth`, `requireAdmin`, `requireCookieAuth`, `requireFreshMfa`,
 * `GET /api/auth/me` and `POST /api/account/switch` deliberately do not, and a
 * guard test freezes that list:
 *
 *   * `requireActorAuth` is the way OUT of a switch. Fencing it would make an
 *     unprovable context unrecoverable. It serves the caller's own rows by
 *     definition, so the selector cannot change what it returns.
 *   * bare `requireAuth` already refuses outright under an active switch.
 *   * `/api/auth/me` is the reconciliation bootstrap and has to answer while
 *     the client's context is unknown — it is where the client LEARNS the
 *     context it would otherwise have to assert.
 *
 * That list is about the auth HELPERS, not about routes, and it is not
 * absolute: `POST /api/admin/backups/[id]/restore` composes the idempotency
 * wrapper OUTSIDE `apiHandler`, so it is fence-visible through the idempotency
 * arm even though `requireAdmin` itself is unfenced. That is wanted. An
 * idempotent admin write under an unprovable context should be refused like any
 * other.
 *
 * ─── Why there are two refusals and not one ───────────────────────────────
 *
 * A stale assertion gets 409 `sharing.session.changed`. An ABSENT assertion on
 * a fenced session gets 403 `sharing.access.denied` instead, and the difference
 * is a deploy-compatibility decision rather than a taxonomy:
 *
 * Header-absent means exactly one thing on the wire — a bundle that predates
 * the fence. A fence-aware client attaches the headers to every same-origin
 * request including the ones issued before `/api/auth/me` has resolved, using
 * the `bootstrap` sentinel, so it can never reach the absent arm. And a
 * pre-fence bundle cannot act on a 409: `src/lib/api/api-fetch.ts` special-cases
 * no status at all, so the tab would render an error card and stay broken until
 * a human reloaded. It CAN act on 403 `sharing.access.denied`, because the
 * deployed bundle already mounts `SharedRecordGrantLossBridge`
 * (`src/components/providers.tsx`), which on the first errored query carrying
 * that code leaves the record and hard-navigates to `/` via `landOnRecord` in
 * `src/hooks/use-account-switch.ts` — a full document navigation, which serves
 * the fence-aware bundle. One reload, self-healing, no new code in the old
 * bundle.
 *
 * So do not "simplify" the two arms into one. The 409 is a *reconcile, do not
 * leave* instruction that only a fence-aware bundle can follow; handing it to a
 * bundle that cannot follow it is the cliff this split exists to avoid.
 */

/** The asserted epoch. Cookie transport only; Bearer neither sends nor honours it. */
export const RECORD_EPOCH_HEADER = "x-healthlog-record-epoch";

/** The asserted canonical scope. Cookie transport only. */
export const RECORD_SCOPE_HEADER = "x-healthlog-record-scope";

/**
 * The scope value naming the caller's own record.
 *
 * A sentinel rather than an empty header, so "I assert I am on my own record"
 * and "I sent no scope at all" are different bytes on the wire. The fence's two
 * refusal arms turn on exactly that distinction.
 */
export const RECORD_SCOPE_SELF = "self";

/**
 * What a fence-aware client asserts before `/api/auth/me` has told it anything.
 *
 * It is a PRESENT header, which is the point: it can never be mistaken for a
 * pre-fence bundle, so it takes the 409 (reconcile) arm and not the 403 (leave
 * the record) arm. On a session that never entered a shared record the
 * exemption below serves it normally, so an ordinary sign-in never sees a 409
 * during boot.
 */
export const RECORD_FENCE_BOOTSTRAP = "bootstrap";

/** The stable code on the 409. The client branches on this, never on prose. */
export const RECORD_FENCE_ERROR_CODE = "sharing.session.changed";

/**
 * Longest asserted scope worth comparing.
 *
 * Same posture and the same number as `MAX_SELECTOR_LENGTH` in
 * `src/lib/auth/acting-carrier.ts` — a bound applied before any parse, so an
 * over-long value is refused as such rather than measured. Deliberately NOT
 * imported from there: that module pulls `next/headers`, and this one is in the
 * client bundle. The unit test asserts the two numbers are equal so they cannot
 * drift apart unnoticed.
 */
export const MAX_ASSERTED_SCOPE_LENGTH = 64;

/**
 * Longest asserted epoch worth parsing. A session's selector moves a handful of
 * times a day at most; fifteen digits is far past any number this counter can
 * reach and short enough that nothing large is ever coerced.
 */
const MAX_ASSERTED_EPOCH_LENGTH = 15;

/**
 * What the two headers said.
 *
 * `absent` and `unparseable` are separate cases because the fence answers them
 * with different status codes — see the two-refusals note above. Collapsing
 * them would hand a pre-fence bundle a status it cannot recover from.
 */
export type AssertedRecordContext =
  | { kind: "absent" }
  | { kind: "unparseable" }
  | { kind: "asserted"; epoch: number; scope: string | null };

/** What the fence decided. */
export type RecordFenceVerdict = "pass" | "stale" | "unfenced-client";

/**
 * Turn the two raw header values into a closed union.
 *
 * No account-shape validation happens here and none is needed: the scope is
 * compared by string equality against the session's real scope, so a bogus
 * asserted account simply fails to match and yields `stale`. Adding a validator
 * would be a second, weaker statement of what an account id is, and the weaker
 * copy is the one that drifts.
 */
export function parseAssertedContext(
  epochHeader: string | null,
  scopeHeader: string | null,
): AssertedRecordContext {
  if (epochHeader === null && scopeHeader === null) return { kind: "absent" };

  // Half an assertion is not an assertion. A fence-aware client sends both on
  // every request, so one-of-two is a client that knows about the fence and got
  // it wrong — which is the `stale` arm, not the pre-fence arm.
  if (epochHeader === null || scopeHeader === null)
    return { kind: "unparseable" };

  if (
    epochHeader.length > MAX_ASSERTED_EPOCH_LENGTH ||
    scopeHeader.length > MAX_ASSERTED_SCOPE_LENGTH ||
    scopeHeader.length === 0
  ) {
    return { kind: "unparseable" };
  }

  // The bootstrap sentinel and every other non-digit value land here together,
  // which is correct: both are "a fence-aware client that cannot yet prove its
  // context", and both must reconcile rather than be served.
  if (!/^\d+$/.test(epochHeader)) return { kind: "unparseable" };

  const epoch = Number(epochHeader);
  if (!Number.isSafeInteger(epoch) || epoch < 0) return { kind: "unparseable" };

  return {
    kind: "asserted",
    epoch,
    scope: scopeHeader === RECORD_SCOPE_SELF ? null : scopeHeader,
  };
}

/**
 * The verdict itself, as a pure function of the transport, the session row and
 * what the request asserted.
 *
 * Pure on purpose, and for the reason `decideActingCarrier` is pure: it is the
 * one statement of the rule, and a rule that needs a request context to be read
 * is a rule that gets re-implemented somewhere it can drift.
 */
export function recordSessionFenceVerdict(input: {
  transport: "cookie" | "bearer";
  /** The session row's counter. Sessions have none on the Bearer transport. */
  sessionEpoch: number;
  /** The account the session is pointed at, or null for its own record. */
  sessionScope: string | null;
  asserted: AssertedRecordContext;
}): RecordFenceVerdict {
  // Bearer carries its selector per request and accumulates no switch state, so
  // there is no context for a token to be stale about. The frozen native
  // contract is untouched: no header is read, required, or honoured here.
  if (input.transport === "bearer") return "pass";

  // The exemption, written as a conjunction even though migration 0302 makes
  // the second clause redundant (it normalised every already-pointed row to 1,
  // and the trigger keeps it there). A redundant clause over an authorization
  // boundary is the right direction to be wrong in, and the redundancy is
  // asserted by the unit test rather than assumed.
  //
  // What it buys: every browser tab open at deploy time that was never inside
  // a shared record keeps working with no header at all, byte for byte. What it
  // costs: a session at epoch 0 is served even if it asserts something odd —
  // which cannot arise, because a client's adopted epoch comes from this very
  // session and a session at 0 has never moved, and which in any case fails
  // open onto the caller's OWN record.
  if (input.sessionEpoch === 0 && input.sessionScope === null) return "pass";

  // From here the session HAS been inside somebody's record, now or before, and
  // stays fenced in both directions permanently. A stale tab believing it is
  // inside the owner's record while the session is back on its own is the same
  // defect as the reverse.
  if (input.asserted.kind === "absent") return "unfenced-client";
  if (input.asserted.kind === "unparseable") return "stale";
  if (input.asserted.epoch !== input.sessionEpoch) return "stale";
  // Belt and braces, deliberately: the epoch alone distinguishes transitions,
  // and the scope additionally catches a selector that moved to a value the
  // client did not expect. On the referential-action path both move at once.
  if (input.asserted.scope !== input.sessionScope) return "stale";

  return "pass";
}

/** The scope header value for a canonical scope. The inverse of the parse above. */
export function recordScopeHeaderValue(scope: string | null): string {
  return scope === null ? RECORD_SCOPE_SELF : scope;
}
