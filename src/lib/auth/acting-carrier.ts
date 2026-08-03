/**
 * What a request says it is acting as.
 *
 * Two things in the app have to answer that question, and they have to answer
 * it the same way:
 *
 *   * `requireRecordAuth` (`src/lib/api-handler.ts`), which turns the claim
 *     into a data scope after checking a live grant.
 *   * `withIdempotency` (`src/lib/idempotency.ts`), which files the replay cell
 *     under the record the request claims — before any handler runs, so it
 *     cannot wait for the grant check the handler performs.
 *
 * The claim is a SELECTOR and never an authorisation. Nothing in this file
 * looks at a grant, and no caller may treat a carrier as permission: the
 * account named here is an id to be checked. What it decides is only which
 * account is being named, and by which transport — the question `grants.ts`
 * warns must have exactly one answer, because a second implementation of it
 * drifts and the copy that drifts is the one nobody reads.
 *
 * The transport rules, unchanged from where they were first written:
 *
 *   * The cookie transport carries the claim on the session ROW. A browser
 *     cannot address that row, so the value is server state written only by
 *     the switch endpoint after it validated a grant.
 *   * The Bearer transport carries it in a per-request HEADER. A long-lived
 *     token must not accumulate switch state.
 *   * The header on a cookie request is `misplaced`, not ignored — a client
 *     that believes it is selecting an account and is not produces a support
 *     case about data that looks wrong.
 */
import { headers } from "next/headers";

import { getSession } from "@/lib/auth/session";

/**
 * The per-request account selector, on the Bearer transport only.
 *
 * Cross-origin JavaScript cannot set it: a custom request header forces a CORS
 * preflight and this app sends no CORS headers at all, so the preflight is
 * never answered. It is a selector regardless — the grant table is what
 * authorises, and the header is treated as hostile input everywhere it is read.
 */
export const ACCOUNT_SELECTOR_HEADER = "x-healthlog-account";

/**
 * Longest selector value worth a database round trip. Account ids are 25-char
 * cuids; anything past this names no account that could exist and is refused
 * as such, on the same path and with the same bytes as an unknown account.
 */
export const MAX_SELECTOR_LENGTH = 64;

/**
 * What, if anything, this request says it is acting as.
 *
 * `misplaced-header` is its own case rather than an error thrown at read time
 * so that every caller decides for itself — the callers disagree about what to
 * do with a misplaced claim and must not disagree about detecting one.
 */
export type ActingCarrier =
  | { kind: "none" }
  | { kind: "session"; accountId: string }
  | { kind: "header"; accountId: string }
  | { kind: "misplaced-header" };

/** The selector header, or null when the request did not send one. */
export async function readSelectorHeader(): Promise<string | null> {
  try {
    const headerList = await headers();
    return headerList.get(ACCOUNT_SELECTOR_HEADER);
  } catch {
    // Outside a Next.js request scope (direct unit invocation of a legacy
    // route) there is no header to read. Same posture as the Bearer branch of
    // `authenticateCaller`.
    return null;
  }
}

/**
 * The carrier decision itself, as a pure function of what the transport
 * carried. Pure on purpose: it is the one statement of the rule, and a rule
 * that needs a request context to be read is a rule that gets re-implemented.
 */
export function decideActingCarrier(input: {
  transport: "cookie" | "bearer";
  /** The session row's stamp. Ignored on the Bearer transport, which has none. */
  stamped: string | null;
  header: string | null;
}): ActingCarrier {
  if (input.transport === "bearer") {
    // No session row exists on this transport, so the header is the only
    // carrier there could be.
    return input.header === null
      ? { kind: "none" }
      : { kind: "header", accountId: input.header };
  }

  if (input.header !== null) return { kind: "misplaced-header" };

  return input.stamped === null
    ? { kind: "none" }
    : { kind: "session", accountId: input.stamped };
}

/** The account a carrier names, or null when it names nothing. */
export function carrierTarget(carrier: ActingCarrier): string | null {
  return "accountId" in carrier ? carrier.accountId : null;
}

/** Could this value name an account at all? */
export function selectorNamesAnAccount(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SELECTOR_LENGTH;
}

/**
 * The account this request CLAIMS, resolved without an auth context in hand.
 *
 * For callers that run BEFORE authentication has been resolved into a context —
 * today that is the idempotency wrapper, which has to know which record a
 * request is aimed at before it decides whether the answer is already cached.
 * It resolves the session itself for exactly one reason: the transport decides
 * which carrier counts, and "there is a valid session" is what the transport
 * is. Guessing it from the presence of a cookie or an `Authorization` header
 * would be a second, weaker answer to a question this file exists to answer
 * once — and the case it gets wrong (a stale session cookie beside a live
 * Bearer token) is precisely a delegated write landing in the wrong cell.
 *
 * The cost is one indexed session lookup on a request that is already about to
 * write. It is not shared with the caller's own auth resolution because the
 * resolver a route passes to `withIdempotency` is pluggable, and threading a
 * session through that seam would make every custom resolver responsible for a
 * question none of them asks.
 *
 * Returns the CLAIMED account, unverified and unchecked. The grant check
 * happens later, inside the handler, on every request.
 */
export async function readClaimedActingAccount(): Promise<string | null> {
  const header = await readSelectorHeader();
  let session: Awaited<ReturnType<typeof getSession>> = null;
  try {
    session = await getSession();
  } catch {
    // A session that cannot be resolved is not a switched one. The request
    // still has to be authenticated by whatever wraps this call, and an
    // unauthenticated request claims nothing.
    session = null;
  }
  return carrierTarget(
    decideActingCarrier({
      transport: session ? "cookie" : "bearer",
      stamped: session?.session.actingAsUserId ?? null,
      header,
    }),
  );
}
