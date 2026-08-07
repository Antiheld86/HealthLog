"use client";

import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.37.0 — what a refused accept, revoke or renounce says, and where it says
 * it.
 *
 * ## The state this replaces
 *
 * These three mutations had no failure rendering at all. They fired, the
 * server answered 409 or 410, or the request never left the machine, and the
 * panel did nothing — the confirm dialog had already closed, the list did not
 * change, and the only signal was the absence of one. The two refusals that
 * matter most were the two that arrived most quietly: an invitation that had
 * lapsed, and the last Guardian being refused a renunciation that would leave
 * a managed profile with nobody looking after it. Both are recoverable, and
 * neither is recoverable by somebody who was not told.
 *
 * ## Every arm names its own recovery
 *
 * A refusal is only worth rendering if it changes what the person does next,
 * so the sentences are split by what the next step is rather than by status
 * code. "Lapsed" leads to asking for a new invitation; "withdrawn" leads
 * nowhere and says so; the last-Guardian refusal names the two ways out the
 * lifecycle actually offers. The offline arm is the one where retrying IS the
 * recovery, so it is separated from a server refusal even though both surface
 * as a failed mutation: a request that never left the machine changed nothing,
 * and telling somebody their access "could not be ended" when it was never
 * asked is a different and worse sentence.
 *
 * `ApiError` carries the server's stable `meta.errorCode`; anything that is
 * not an `ApiError` never reached a response at all, which is what makes the
 * offline test a type check rather than a status check.
 */
export type GrantAction =
  "accept" | "revoke" | "renounce" | "deleteProfile" | "removeGuardian";

/** The generic sentence for each act, when nothing more specific applies. */
const FAILED_KEY: Record<GrantAction, string> = {
  accept: "recordSharing.actionError.acceptFailed",
  revoke: "recordSharing.actionError.revokeFailed",
  renounce: "recordSharing.actionError.renounceFailed",
  deleteProfile: "recordSharing.actionError.deleteProfileFailed",
  removeGuardian: "recordSharing.actionError.removeGuardianFailed",
};

/**
 * The acts whose routes resolve `requireFreshMfa`, and therefore the only ones
 * where a 401 is a gate rather than a lapsed session.
 *
 * A set rather than a condition, so adding a third step-up-gated act is one
 * line here instead of a boolean somebody has to re-derive.
 */
const STEP_UP_ACTIONS = new Set<GrantAction>([
  "deleteProfile",
  "removeGuardian",
]);

/**
 * Which of the two step-up sentences a 401 from the managed-profile family
 * earns.
 *
 * `requireFreshMfa` refuses for two different reasons and says which: a stale
 * proof (`auth.stepup.required`), which the person clears by proving their
 * factor, and NO factor at all (`auth.stepup.mfa_not_enrolled`), which they
 * cannot clear that way. Collapsing the two tells somebody with no second
 * factor to confirm one — a dead end offered by the very surface that owns
 * the route out of it.
 *
 * Exported and shared by every caller in the family (creation, the guardian
 * invitation, and the two acts below) so the two sentences cannot come apart.
 */
export function stepUpErrorKey(err: ApiError): string {
  return err.meta?.errorCode === "auth.stepup.mfa_not_enrolled"
    ? "recordSharing.managed.errorMfaRequired"
    : "recordSharing.managed.errorStepUp";
}

/**
 * The message key for a refused grant action.
 *
 * Pure and exported so the mapping can be pinned without a click: the panel's
 * error states are otherwise only reachable by driving a browser, and a
 * mapping nobody can test is a mapping that drifts.
 */
export function grantActionErrorKey(err: unknown, action: GrantAction): string {
  // Not an `ApiError` means no response came back — a dropped connection, a
  // sleeping laptop, a server that is not there. Nothing was decided, so the
  // sentence says so and points at the retry rather than reporting a refusal
  // the server never issued.
  if (!(err instanceof ApiError)) return "recordSharing.actionError.offline";

  const code =
    typeof err.meta?.errorCode === "string" ? err.meta.errorCode : null;

  switch (code) {
    // The one refusal that protects a person rather than a row. It reaches
    // both sides — the owner withdrawing the last Guardian's access and the
    // last Guardian handing it back — and it is the same fact either way, so
    // it is the same sentence.
    case "managed_profile.guardian.required":
      return "recordSharing.actionError.lastGuardian";
    // v1.37.0 — the only refusal the delete route classifies, and the only one
    // the guardian-removal route classifies besides the floor. It covers three
    // situations the server deliberately does not tell apart (no such profile,
    // not a managed one, the caller is not its Guardian), so the sentence
    // promises no diagnosis: it says the profile is not reachable and leaves
    // it there. Anything the route does NOT classify becomes the generic 500
    // envelope and must not borrow this sentence.
    case "managed_profile.not_found":
      return "recordSharing.actionError.profileNotFound";
    case "sharing.accept.expired":
      return "recordSharing.actionError.acceptExpired";
    case "sharing.accept.revoked":
      return "recordSharing.actionError.acceptWithdrawn";
    case "sharing.accept.not_pending":
      return "recordSharing.actionError.acceptNotPending";
    case "sharing.accept.not_found":
      return "recordSharing.actionError.acceptNotFound";
    case "sharing.revoke.already_ended":
    case "sharing.renounce.already_ended":
      return "recordSharing.actionError.alreadyEnded";
    case "sharing.revoke.not_found":
    case "sharing.renounce.not_found":
      return "recordSharing.actionError.notFound";
    default:
      break;
  }

  // Waiting is the recovery, so it must not read as a failure. The accept
  // route rate-limits without an error code, hence the status.
  if (err.status === 429) return "recordSharing.actionError.rateLimited";

  // v1.37.0 — the step-up gate, on the two acts that carry one.
  //
  // Scoped by action rather than applied to every 401, and that is the whole
  // care in it. `DELETE /api/managed-profiles/{id}` and
  // `DELETE .../guardians/{grantId}` resolve `requireFreshMfa`, so a 401 there
  // is a gate somebody can clear. Accept, revoke and renounce resolve plain
  // `requireAuth`, where a 401 means the session ended — and telling that
  // person to confirm a second factor sends them looking for the wrong thing.
  //
  // These two are also the likeliest to hit it: both sit behind a
  // `ConfirmButton`, so the click that reaches the server is the second one,
  // minutes after the panel was opened, and the five-minute window is easy to
  // be outside of by then. Before this arm they fell through to "the profile
  // could not be deleted", which describes nothing and offers nothing.
  if (err.status === 401 && STEP_UP_ACTIONS.has(action)) {
    return stepUpErrorKey(err);
  }

  return FAILED_KEY[action];
}

/**
 * The refusal, on the row it belongs to.
 *
 * `role="alert"` because it appears after the act rather than with the page:
 * a person who pressed a button and got nothing has already looked away, and
 * a screen reader that does not announce it is the same silence the panel had
 * before. `text-destructive` because this is content somebody has to act on —
 * UI-STANDARDS §3 reserves muted for meta, and a refusal rendered as meta is a
 * refusal nobody reads.
 *
 * `data-grant-error-for` carries the row id so a panel holding two failed rows
 * cannot show one row's message against another's, and so a browser journey
 * can assert which row was refused rather than that something somewhere went
 * red.
 */
export function GrantActionAlert({
  grantId,
  message,
  onRetry,
  retrying = false,
}: {
  grantId: string;
  message: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  const { t } = useTranslations();
  return (
    <div
      data-slot="grant-action-error"
      data-grant-error-for={grantId}
      role="alert"
      className="text-destructive flex flex-wrap items-center gap-2 text-sm"
    >
      <span>{message}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-slot="grant-action-retry"
        disabled={retrying}
        onClick={onRetry}
      >
        {t("recordSharing.actionError.retry")}
      </Button>
    </div>
  );
}
