import type { NotificationPayload } from "@/lib/notifications/types";

/**
 * A cross-account notification can only reach a Guardian after the
 * dispatcher has revalidated the marked record and its active MANAGE grant.
 * Senders use this narrow invariant to remove record-mutating affordances.
 */
export function isManagedGuardianDelivery(
  payload: Pick<NotificationPayload, "recordUserId" | "recipientUserId">,
): boolean {
  return (
    payload.recordUserId !== undefined &&
    payload.recipientUserId !== undefined &&
    payload.recordUserId !== payload.recipientUserId
  );
}
