/**
 * v1.36.x — "somebody else marked your dose".
 *
 * The one notification a delegated write produces. Everything else a delegate
 * adds to a shared record (a reading, a lab result, an allergy) is bookkeeping
 * and lives in the owner's activity view; a dose is a statement about the
 * owner's own body, and the owner is the person best placed to decide whether
 * they want to hear about it. So this rides the ordinary alert cascade with an
 * ordinary per-channel preference row, and nothing about it is special-cased
 * inside the dispatcher.
 *
 * Two properties are structural rather than observed:
 *
 *  1. **It refuses to fire on self.** The owner never gets a push about their
 *     own dose. The refusal lives HERE, not at the call sites, so a future
 *     route that calls this helper cannot forget it.
 *  2. **It addresses the owner and only the owner.** The delegate gets their
 *     feedback from the response they are already awaiting, rendered in their
 *     own session. There is no delegate-directed push and this file is not the
 *     place to grow one: the dispatcher takes a `userId`, and under record
 *     substitution that id is the owner by design.
 *
 * The medication is named in the push body, the same verbosity class as
 * MEDICATION_REMINDER, which has named medications on the lock screen since
 * v1.4.40. No dose figures ride along.
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { accountLabel } from "@/lib/sharing/account-access-view";
import { dispatchLocalisedNotification } from "@/lib/notifications/dispatch-localised";

/**
 * The dose states the intake routes write. `"snoozed"` is deliberately in the
 * union: both intake routes can produce it, and the helper answering "that one
 * is not a marking" in one place beats every call site remembering to.
 */
export type DelegatedIntakeStatus = "taken" | "skipped" | "snoozed";

/**
 * Which body the push carries for a dose state, or `null` when the state is
 * not a marking at all.
 *
 * Pure, exported, and tested on its own: a snooze moves a dose, it does not
 * resolve it, and the web-push dose-clear draws the same line (`intake/route
 * .ts` clears the pending reminder for taken / skipped only). An owner woken
 * by "your carer postponed a dose by ten minutes" would be the noise this
 * whole event type is trying not to be.
 */
export function delegatedIntakeMessageKey(
  status: DelegatedIntakeStatus,
): string | null {
  switch (status) {
    case "taken":
      return "notifications.sharedRecordIntake.bodyTaken";
    case "skipped":
      return "notifications.sharedRecordIntake.bodySkipped";
    case "snoozed":
      return null;
  }
}

export interface NotifyDelegatedIntakeInput {
  /** The account the dose belongs to — the recipient of the notification. */
  ownerId: string;
  /** The account that actually marked it. Equal to `ownerId` on a self-write. */
  actorId: string;
  /** The medication whose dose was marked. Resolved for its name, owner-scoped. */
  medicationId: string;
  /** What the dose was marked as. */
  status: DelegatedIntakeStatus;
}

/**
 * Tell the owner that somebody else marked one of their doses.
 *
 * Never throws: a notification that fails is not a reason to fail the write
 * that produced it. The call sites do NOT await it, and this line used to say
 * the opposite. The dispatcher awaits each channel of the cascade in turn, so
 * one unreachable channel added its whole timeout to the request of the person
 * standing next to the patient waiting for a dose to register — which is the
 * one request in this product that should never be slow. The owner learning a
 * moment later is the better trade. The integration test polls the
 * `push_attempts` ledger rather than relying on the await, so nothing about
 * the proof depends on the caller's choice here.
 */
export async function notifyDelegatedIntake(
  input: NotifyDelegatedIntakeInput,
): Promise<void> {
  const { ownerId, actorId, medicationId, status } = input;

  // The self refusal. First, cheap, and unconditional.
  if (actorId === ownerId) return;

  const messageKey = delegatedIntakeMessageKey(status);
  if (messageKey === null) return;

  try {
    const [actor, medication] = await Promise.all([
      prisma.user.findUnique({
        where: { id: actorId },
        select: { username: true, displayName: true },
      }),
      // Scoped to the owner: the name in this body goes onto the owner's lock
      // screen, so it is read from the owner's own row set or not at all.
      prisma.medication.findFirst({
        where: { id: medicationId, userId: ownerId },
        select: { name: true },
      }),
    ]);

    // Both halves of the sentence or none of it. An acting account that no
    // longer resolves is nobody we can name, and a medication that does not
    // resolve under the OWNER is not one whose name belongs on their lock
    // screen. Neither is reachable from the intake routes, which have both
    // rows in hand before they call; a warning to ops beats a push that says
    // "somebody marked something".
    if (!actor || !medication) {
      getEvent()?.addWarning(
        `notifyDelegatedIntake — nothing to name (actor=${actor ? "ok" : "missing"} medication=${medication ? "ok" : "missing"}), no notification sent`,
      );
      return;
    }

    await dispatchLocalisedNotification({
      userId: ownerId,
      eventType: "SHARED_RECORD_INTAKE",
      titleKey: "notifications.sharedRecordIntake.title",
      messageKey,
      params: {
        name: accountLabel(actor),
        medication: medication.name,
      },
      metadata: { medicationId },
    });
  } catch (err) {
    getEvent()?.addWarning(
      `notifyDelegatedIntake failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
