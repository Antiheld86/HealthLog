import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import type { Prisma } from "@/generated/prisma/client";

type Transaction = Prisma.TransactionClient;

export const activeGuardianWhere = (now: Date) => ({
  access: "MANAGE" as const,
  acceptedAt: { not: null },
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
});

export type ManagedProfileLifecycleErrorCode =
  "not_found" | "not_managed" | "not_guardian" | "managed_grantee";

export class ManagedProfileLifecycleError extends Error {
  constructor(readonly code: ManagedProfileLifecycleErrorCode) {
    super(`managed profile lifecycle refused: ${code}`);
    this.name = "ManagedProfileLifecycleError";
  }
}

/** A refusal the caller can recover from by adding another Guardian. */
export class LastManagedGuardianError extends Error {
  constructor() {
    super("A managed profile needs another Guardian before this change");
    this.name = "LastManagedGuardianError";
  }
}

/**
 * Serialize lifecycle changes on one managed-record key for the lifetime of
 * the caller's transaction. The lock is held before re-reading the marker and
 * every active Guardian row, so a second reducer sees the first committed
 * change instead of making its decision from a stale count.
 */
export async function withManagedProfileLock<T>(
  tx: Transaction,
  profileId: string,
  operation: (
    profile: { id: string; managedProfileAt: Date | null } | null,
  ) => Promise<T>,
): Promise<T> {
  await tx.$queryRaw`
    SELECT 1 AS locked
    FROM pg_advisory_xact_lock(hashtextextended(${`managed-profile:${profileId}`}, 0))
  `;
  const profile = await tx.user.findUnique({
    where: { id: profileId },
    select: { id: true, managedProfileAt: true },
  });
  return operation(profile);
}

/**
 * Run one removal of an active Guardian after holding the record lock and
 * re-reading the invariant in the same transaction.
 */
export async function reduceManagedProfileGuardian<T>(
  tx: Transaction,
  profileId: string,
  reduction: () => Promise<T>,
): Promise<T> {
  return withManagedProfileLock(tx, profileId, async (profile) => {
    if (!profile?.managedProfileAt) return reduction();

    const activeGuardians = await tx.accountGrant.count({
      where: { grantorId: profile.id, ...activeGuardianWhere(new Date()) },
    });
    if (activeGuardians <= 1) throw new LastManagedGuardianError();

    return reduction();
  });
}

/**
 * Keep account deletion and its Guardian checks inside the same transaction.
 * Profiles are locked in id order so an account protecting more than one
 * profile cannot deadlock with a concurrent lifecycle operation.
 */
export async function deleteGuardianAccountWithLifecycle<T>(
  guardianId: string,
  deleteAccount: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const grants = await tx.accountGrant.findMany({
      where: {
        granteeId: guardianId,
        ...activeGuardianWhere(now),
        grantor: { managedProfileAt: { not: null } },
      },
      select: { grantorId: true },
      distinct: ["grantorId"],
      orderBy: { grantorId: "asc" },
    });

    for (const { grantorId } of grants) {
      await withManagedProfileLock(tx, grantorId, async (profile) => {
        if (!profile?.managedProfileAt) return;

        const stillActive = await tx.accountGrant.findFirst({
          where: {
            grantorId,
            granteeId: guardianId,
            ...activeGuardianWhere(new Date()),
          },
          select: { id: true },
        });
        if (!stillActive) return;

        const activeGuardians = await tx.accountGrant.count({
          where: { grantorId, ...activeGuardianWhere(new Date()) },
        });
        if (activeGuardians <= 1) throw new LastManagedGuardianError();
      });
    }

    return deleteAccount(tx);
  });
}

/**
 * Hold every managed-record lock affected by a data wipe, then prove that the
 * wipe will not leave a managed profile with no active Guardian. The caller
 * keeps the transaction open through the AccountGrant deletion, so a final
 * notification egress claim observes either the live grants before the wipe
 * or the committed deletion afterwards; it cannot authorize in between.
 *
 * A data wipe keeps the account and its managed-profile marker. It therefore
 * refuses rather than silently turning the last Guardian removal into an
 * unmanaged profile. Deleting the managed profile remains the explicit
 * product action for that case.
 */
export async function protectManagedProfilesDuringDataWipe(
  tx: Transaction,
  userId: string,
): Promise<void> {
  const affectedProfiles = await tx.accountGrant.findMany({
    where: {
      OR: [{ grantorId: userId }, { granteeId: userId }],
      grantor: { managedProfileAt: { not: null } },
    },
    select: { grantorId: true },
    distinct: ["grantorId"],
    orderBy: { grantorId: "asc" },
  });

  // Acquire every key before reading the final state. Sorting is required
  // because a wipe can affect more than one managed profile.
  for (const { grantorId } of affectedProfiles) {
    await withManagedProfileLock(tx, grantorId, async () => undefined);
  }

  // Re-read after all locks are held. A concurrent acceptance, revocation,
  // expiry reduction, or notification claim uses the same key and is now
  // ordered entirely before or after this transaction.
  const now = new Date();
  for (const { grantorId } of affectedProfiles) {
    await withManagedProfileLock(tx, grantorId, async (profile) => {
      if (!profile?.managedProfileAt) return;

      const [activeGuardians, guardiansRemovedByWipe] = await Promise.all([
        tx.accountGrant.count({
          where: { grantorId: profile.id, ...activeGuardianWhere(now) },
        }),
        tx.accountGrant.count({
          where: {
            AND: [
              { grantorId: profile.id },
              { OR: [{ grantorId: userId }, { granteeId: userId }] },
              activeGuardianWhere(now),
            ],
          },
        }),
      ]);

      if (activeGuardians <= guardiansRemovedByWipe) {
        throw new LastManagedGuardianError();
      }
    });
  }
}

export async function deleteManagedProfile(input: {
  profileId: string;
  guardianId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await withManagedProfileLock(tx, input.profileId, async (profile) => {
      if (!profile) throw new ManagedProfileLifecycleError("not_found");
      if (!profile.managedProfileAt) {
        throw new ManagedProfileLifecycleError("not_managed");
      }

      const guardian = await tx.accountGrant.findFirst({
        where: {
          grantorId: profile.id,
          granteeId: input.guardianId,
          ...activeGuardianWhere(new Date()),
        },
        select: { id: true },
      });
      if (!guardian) throw new ManagedProfileLifecycleError("not_guardian");

      await auditLog("managed_profile.deleted", {
        userId: input.guardianId,
        details: { profileId: profile.id },
        client: tx,
      });
      await tx.user.delete({ where: { id: profile.id } });
    });
  });
}

/**
 * Internal-only future compatibility hook. There is intentionally no route for
 * this state change in the current product; holding the same lock ensures any
 * later handover cannot race a Guardian reduction.
 */
export async function clearManagedProfileMarker(input: {
  profileId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await withManagedProfileLock(tx, input.profileId, async (profile) => {
      if (!profile) throw new ManagedProfileLifecycleError("not_found");
      if (!profile.managedProfileAt) return;
      await tx.user.update({
        where: { id: profile.id },
        data: { managedProfileAt: null },
      });
    });
  });
}
