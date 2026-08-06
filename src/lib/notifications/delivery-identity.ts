import { prisma } from "@/lib/db";
import {
  activeGuardianWhere,
  withManagedProfileLock,
} from "@/lib/managed-profiles/lifecycle";
import type { NotificationPayload } from "@/lib/notifications/types";

export interface NotificationDeliveryIdentity {
  recordUserId: string;
  recipientUserId: string;
  managed: boolean;
}

/**
 * Resolve notification identities without treating a managed record as its
 * own destination. Legacy payloads remain valid only for ordinary self
 * delivery; a managed record must name an active Guardian explicitly.
 *
 * Cross-principal authorization linearizes at the locked grant read below,
 * immediately before the dispatcher selects a channel. A revocation that
 * commits before that read prevents delivery; one that commits afterwards
 * affects later dispatches but cannot recall provider work already in flight.
 * The provider call deliberately runs outside the short database transaction.
 */
export async function resolveNotificationDeliveryIdentity(
  payload: NotificationPayload,
): Promise<NotificationDeliveryIdentity | null> {
  const hasRecordUserId = payload.recordUserId !== undefined;
  const hasRecipientUserId = payload.recipientUserId !== undefined;

  if (hasRecordUserId !== hasRecipientUserId) return null;

  const recordUserId = payload.recordUserId ?? payload.userId;
  const recipientUserId = payload.recipientUserId ?? payload.userId;
  if (!recordUserId || !recipientUserId || payload.userId !== recordUserId) {
    return null;
  }

  const record = await prisma.user.findUnique({
    where: { id: recordUserId },
    select: { managedProfileAt: true },
  });
  if (!record) return null;

  if (record.managedProfileAt == null) {
    return recipientUserId === recordUserId
      ? { recordUserId, recipientUserId, managed: false }
      : null;
  }

  if (recipientUserId === recordUserId) return null;

  return prisma.$transaction(async (tx) =>
    withManagedProfileLock(tx, recordUserId, async (lockedRecord) => {
      if (lockedRecord?.managedProfileAt == null) return null;

      const recipient = await tx.user.findUnique({
        where: { id: recipientUserId },
        select: { managedProfileAt: true },
      });
      if (!recipient || recipient.managedProfileAt != null) return null;

      const guardian = await tx.accountGrant.findFirst({
        where: {
          grantorId: recordUserId,
          granteeId: recipientUserId,
          ...activeGuardianWhere(new Date()),
        },
        select: { id: true },
      });
      if (!guardian) return null;

      return { recordUserId, recipientUserId, managed: true };
    }),
  );
}
