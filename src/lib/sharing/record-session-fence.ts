/**
 * v1.37.0 — the server half of the record-session fence.
 *
 * The rule itself lives next door in `record-session-fence-contract.ts`, which
 * imports nothing so the browser bundle can name the same headers. This file is
 * the part that cannot be in a browser: it reads `next/headers`, it holds the
 * refusals, and it stamps the wide event that becomes the response echo.
 *
 * Three things happen on every call, and the order matters:
 *
 *   1. Read the two asserted headers.
 *   2. Stamp the context the request is ACTUALLY being served under onto the
 *      request-scoped wide event — on every call, pass or refuse. `apiHandler`
 *      turns that stamp into the response echo, and this is the only thing that
 *      ever stamps it. The alternative that looks equivalent is not: the wide
 *      event's `setActingAs` runs in exactly one place, inside
 *      `resolveSwitchedRecord`, so it never fires on the carrier-none path, on
 *      an actor surface, or on a public route — and a client rule of "2xx with
 *      no echo means discard" would then throw away every actor and public
 *      response, including the `/api/version` poll that runs on a timer.
 *   3. Refuse, or return.
 *
 * ─── The atomicity property, stated once ──────────────────────────────────
 *
 * The epoch compared here and the `actingAsUserId` the resolver is about to
 * serve under come from ONE `getSession()` row read — `findSessionByCookie`
 * loads the whole row and both fields are projected off it. So "the scope the
 * handler serves under" and "the epoch the fence validated" are the same fact
 * read at the same instant, not two reads a switch can land between. That turns
 * what would be a race window into a tautology, and it is why this function
 * takes an `AuthContext` instead of resolving a session of its own. Do not add
 * a second session read here for any reason.
 *
 * What that does NOT close, and nothing can: a request that has already passed
 * the fence when a switch commits still completes under the context it was
 * admitted with. Holding a lock across the handler's I/O would close it and was
 * examined and rejected during v1.37.0 planning — it buys a disclosure window
 * measured in milliseconds at the price of lock, pool, timeout and revocation
 * availability defects. What covers it instead is the response echo: the client
 * discards a response whose echoed context contradicts the one it is now on.
 */
import { headers } from "next/headers";

import {
  RECORD_EPOCH_HEADER,
  RECORD_SCOPE_HEADER,
  parseAssertedContext,
  recordSessionFenceVerdict,
  type AssertedRecordContext,
} from "@/lib/sharing/record-session-fence-contract";
import {
  RecordSessionChangedError,
  SharingAccessDeniedError,
  type AuthContext,
} from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";

/**
 * What this request asserted about its record context.
 *
 * `try`/`catch`-wrapped the way `readSelectorHeader` is: outside a Next.js
 * request scope there is no header to read, and a direct unit invocation of a
 * legacy route must not crash on the attempt. An unreadable header store is
 * indistinguishable from a request that sent nothing, which is the honest
 * answer — and on a fenced session that answer is refused, not served.
 */
export async function readAssertedRecordContext(): Promise<AssertedRecordContext> {
  try {
    const headerList = await headers();
    return parseAssertedContext(
      headerList.get(RECORD_EPOCH_HEADER),
      headerList.get(RECORD_SCOPE_HEADER),
    );
  } catch {
    return { kind: "absent" };
  }
}

/**
 * Refuse this request if the record context it asserted is not the one its
 * session is on.
 *
 * Called by `requireRecordAuth` and `requireGuardianAuth` immediately after
 * `authenticateCaller()` and before `readActingCarrier()`, and independently by
 * `withIdempotency` above the replay cache. Two independent evaluations against
 * the same client assertion, with nothing carried between them: carrying a
 * verdict across the wrapper/handler boundary would need request-scoped mutable
 * state, which is a second source of truth for the same question. A switch
 * landing between the two evaluations fails the second, so no handler body runs
 * under a scope the asserted epoch does not imply.
 */
export async function assertRecordSessionFence(
  auth: AuthContext,
): Promise<void> {
  const transport = auth.authMethod === "bearer" ? "bearer" : "cookie";
  const sessionEpoch = auth.session.recordEpoch ?? 0;
  const sessionScope = auth.session.actingAsUserId ?? null;

  // Stamped before the verdict, so a refusal echoes the truth too. The Bearer
  // transport carries no session context to echo and gets none: the frozen
  // native contract sends no fence header and receives none back.
  if (transport === "cookie") {
    getEvent()?.setRecordContext({ epoch: sessionEpoch, scope: sessionScope });
  }

  const asserted = await readAssertedRecordContext();
  const verdict = recordSessionFenceVerdict({
    transport,
    sessionEpoch,
    sessionScope,
    asserted,
  });

  if (verdict === "pass") return;

  if (verdict === "stale") {
    annotate({ meta: { sharing_refusal: "record_context_stale" } });
    throw new RecordSessionChangedError();
  }

  // `unfenced-client`: a bundle that predates the fence, inside or after a
  // shared-record context. It gets the code it already recovers from — see the
  // two-refusals note in the contract module.
  //
  // No audit row, and that follows the rule already written for the session
  // carrier in `api-handler.ts`: a HEADER refusal is a per-request assertion by
  // a client and earns a durable record, a SESSION-state refusal is ambient
  // browser state and would bury the rows that matter under noise from the
  // feature working as designed. This arm is the second kind — every
  // navigation, prefetch and poll from one stale tab lands here until it
  // reloads, and the reload is the designed outcome.
  annotate({ meta: { sharing_refusal: "unfenced_client" } });
  throw new SharingAccessDeniedError();
}
