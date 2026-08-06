import { prisma } from "@/lib/db";
import type { NotificationPayload } from "@/lib/notifications/types";

export interface NotificationDeliveryIdentity {
  recordUserId: string;
  recipientUserId: string;
  managed: boolean;
}

/**
 * Resolve notification identities without treating a managed record as its
 * own destination. Legacy payloads remain valid only for ordinary self
 * delivery; a managed record must name its recipient explicitly.
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

  const managed = record.managedProfileAt != null;
  if (managed) {
    return recipientUserId === recordUserId
      ? null
      : { recordUserId, recipientUserId, managed };
  }

  return recipientUserId === recordUserId
    ? { recordUserId, recipientUserId, managed }
    : null;
}
