/**
 * Error classes for `apiHandler`-wrapped routes — a LEAF module.
 *
 * Moved out of `api-handler.ts` to break the one real import cycle in the
 * tree: api-handler imports the record-session fence, and the fence threw
 * `RecordSessionChangedError` / `SharingAccessDeniedError` imported back
 * from api-handler — a loop that only worked by evaluation-order luck.
 * This module imports nothing but the fence CONTRACT constants (itself a
 * leaf), so anything may import it. `api-handler.ts` re-exports every
 * class, so the ~500 existing importers read exactly as before.
 */
import { RECORD_FENCE_ERROR_CODE } from "./sharing/record-session-fence-contract";

/**
 * Custom error class for HTTP errors with status codes.
 * Throw inside apiHandler-wrapped routes to return a JSON error response.
 */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * v1.36.0 — the two refusals the acting-account resolver can raise.
 *
 * Both are 403 with a stable `meta.errorCode`, the same envelope shape the
 * step-up and consent gates already use, so a client branches on the code
 * rather than on prose.
 */
export abstract class SharingAuthError extends HttpError {
  abstract readonly errorCode: string;
}

/**
 * "You may not act as that account."
 *
 * Deliberately parameterless. The message is a fixed literal and the
 * constructor takes no arguments, so there is no way for a caller to vary the
 * response — which is what makes a selector naming an account that does not
 * exist and one naming an account that granted nothing produce the SAME BYTES.
 * That is not a formatting nicety: a distinguishable refusal turns this
 * endpoint into an account-enumeration oracle for anyone with a login.
 *
 * The indistinguishability is structural rather than careful, too. Neither
 * branch ever looks an account up: the resolver asks the grant table for the
 * (owner, delegate) pair and a missing account and a missing grant are the
 * same empty result, on the same code path, after the same one query.
 *
 * Why the reason is not in the response at all: the caller already knows what
 * they sent, and the only party who benefits from knowing WHICH condition
 * failed is someone probing. The reason goes to the audit row and the wide
 * event, where the owner and the operator can see it.
 */
export class SharingAccessDeniedError extends SharingAuthError {
  readonly errorCode = "sharing.access.denied";
  constructor() {
    super(403, "Account access denied");
    this.name = "SharingAccessDeniedError";
  }
}

/**
 * "This endpoint does not act on another account's record."
 *
 * A different fact from the one above and so a different code: nothing here is
 * about whether a grant exists. The route simply never declared that it can be
 * used under a switch, so it refuses rather than quietly serving the caller's
 * OWN record — which is the reverse data-mixing failure, and the reason this
 * class exists at all. A delegate who believes they are reading the owner's
 * record must never be handed their own instead.
 */
export class SharingNotPermittedError extends SharingAuthError {
  readonly errorCode = "sharing.not_permitted";
  constructor() {
    super(403, "This endpoint cannot be used while acting on another account");
    this.name = "SharingNotPermittedError";
  }
}

/**
 * v1.37.0 — "the record this session is on is not the record you asserted."
 *
 * A third sibling rather than a branch, so it rides the existing
 * `SharingAuthError` arm with no new serialisation code. The status is
 * the one thing that differs and it differs on purpose: 409, not 403, because
 * this is not a refusal of access. The caller may well be entitled to both
 * records. What failed is agreement about WHICH one, and the instruction the
 * code carries is "reconcile through `/api/auth/me` and try again", not "you
 * have lost this record".
 *
 * That distinction is load-bearing for deploy compatibility: the currently
 * shipped bundle reacts to `sharing.access.denied` by leaving the record and
 * hard-navigating, which is exactly the wrong response to a transient
 * disagreement and exactly the right one for a bundle too old to reconcile. See
 * `src/lib/sharing/record-session-fence-contract.ts` for why the fence hands
 * each bundle the code it can act on.
 *
 * The body carries `meta.errorCode` and nothing else — no current epoch, no
 * current scope. A client may learn its context from exactly two responses
 * (`GET /api/auth/me` and `POST /api/account/switch`), and putting the truth in
 * this refusal would open a third path, one that arrives on the very requests
 * whose context is in doubt.
 */
export class RecordSessionChangedError extends SharingAuthError {
  readonly errorCode = RECORD_FENCE_ERROR_CODE;
  constructor() {
    super(409, "The record this session is on has changed");
    this.name = "RecordSessionChangedError";
  }
}

/**
 * Error thrown when a step-up gate is not satisfied. Carries `errorCode` so
 * the route can surface a stable machine code (`auth.stepup.required`) the
 * client branches on to launch a re-verification flow rather than parsing
 * prose.
 */
export class StepUpRequiredError extends HttpError {
  constructor(
    public errorCode: string = "auth.stepup.required",
    message = "Recent second-factor verification required",
  ) {
    super(401, message);
    this.name = "StepUpRequiredError";
  }
}
