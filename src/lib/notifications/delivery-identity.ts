import { prisma } from "@/lib/db";
import {
  activeGuardianWhere,
  withManagedProfileLock,
} from "@/lib/managed-profiles/lifecycle";
import type {
  ManagedGuardianFanoutEvent,
  NotificationPayload,
} from "@/lib/notifications/types";

export interface NotificationDeliveryIdentity {
  recordUserId: string;
  recipientUserId: string;
  managed: boolean;
}

/**
 * The policy is deliberately closed. `SYSTEM_ALERT` by itself is never a
 * Guardian event: the safety-floor producer must name its narrow admission
 * marker, while illness red flags continue to remain record-local.
 */
export function isManagedGuardianFanoutAllowed(
  payload: Pick<NotificationPayload, "eventType" | "managedFanoutEvent">,
): boolean {
  if (payload.managedFanoutEvent === "SAFETY_FLOOR_ALERT") {
    return payload.eventType === "SYSTEM_ALERT";
  }

  return (
    payload.managedFanoutEvent === undefined &&
    (payload.eventType === "MEDICATION_REMINDER" ||
      payload.eventType === "MEASUREMENT_REMINDER" ||
      payload.eventType === "MEDICATION_LOW_STOCK")
  );
}

/**
 * Enumerate candidate Guardians only for a legacy record-addressed delivery.
 * Each candidate is still re-authorized under the managed-profile advisory
 * lock immediately before its own channel selection and provider egress.
 */
export async function resolveManagedGuardianRecipientIds(
  payload: NotificationPayload,
): Promise<string[] | null> {
  if (
    payload.recordUserId !== undefined ||
    payload.recipientUserId !== undefined ||
    !isManagedGuardianFanoutAllowed(payload)
  ) {
    return null;
  }

  const record = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { managedProfileAt: true },
  });
  if (record?.managedProfileAt == null) return null;

  const grants = await prisma.accountGrant.findMany({
    where: {
      grantorId: payload.userId,
      ...activeGuardianWhere(new Date()),
      grantee: { managedProfileAt: null },
    },
    select: {
      granteeId: true,
      grantee: { select: { managedProfileAt: true } },
    },
  });

  return grants
    .filter(
      (grant) =>
        grant.granteeId !== payload.userId &&
        grant.grantee.managedProfileAt == null,
    )
    .map((grant) => grant.granteeId);
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

  if (!isManagedGuardianFanoutAllowed(payload)) return null;

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
