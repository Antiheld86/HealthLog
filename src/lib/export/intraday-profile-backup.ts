/**
 * The intraday shape of a cumulative day — both ends in one file.
 *
 * `IntradayCumulativeProfile` arrived in v1.34.0 classified `BACKED_UP` with a
 * sound reason and carried by nothing, which is the exact shape of defect
 * `backup-plan.ts` exists to make visible. The reason still holds: the nightly
 * drain folds the per-sample rows into these twenty-four running totals and
 * hard-deletes the originals in the same transaction, so past the 36-hour grace
 * window this table is the ONLY copy of a day's curve. A restore without it
 * rebuilds the account with every historical shape gone and reports success,
 * and the same-time baseline silently reads "still learning" for a fortnight
 * while it re-accumulates days it already had.
 *
 * The builder and the restore live together deliberately, the way
 * `profile-backup.ts` and `src/lib/cycle/backup.ts` do: a reader asking "is
 * this carried at both ends?" answers it in one file, and a reader who greps
 * only the restore ROUTE gets a false negative, because the route delegates.
 *
 * Nothing here is encrypted, so there is no portable/DR split on the values.
 * The only difference between the two purposes is identity: a canonical
 * disaster-recovery payload carries the row id and its timestamps so the row
 * comes back as itself, a portable export carries the shape alone.
 */
import type {
  MeasurementType,
  Prisma,
  PrismaClient,
} from "@/generated/prisma/client";

/**
 * Slots one stored profile carries.
 *
 * Re-declared rather than imported from
 * `src/lib/measurements/intraday-cumulative-profile.ts`, which reaches for the
 * global Prisma client at module load — a payload builder must not drag a
 * database connection into every process that serialises a backup. The two
 * constants are pinned to each other by this module's own test, so the
 * duplication cannot drift silently.
 */
export const PROFILE_BACKUP_HOURS = 24;

export interface IntradayProfileBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/** One local day's cumulative curve for one metric. */
export interface IntradayProfileBackupEntry {
  /** Present in canonical DR payloads so the row keeps a stable identity. */
  id?: string;
  type: MeasurementType;
  /** Local calendar day (`YYYY-MM-DD`) in `timezone`. */
  dateKey: string;
  /**
   * Twenty-four running totals; element `h` is everything accumulated through
   * the END of local hour `h`. Exactly 24 on every day, DST included — the
   * reader indexes by hour and drops any row of another length, so a
   * wrong-length array restores into a row nothing will ever read.
   */
  hourlyCumulative: number[];
  dayTotal: number;
  sampleCount: number;
  /**
   * The IANA zone the day was cut on. Carried because the reader compares it
   * against the account's current zone and drops the mismatched days; a
   * restore that guessed the zone would make old days look comparable when
   * their hours mean something else.
   */
  timezone: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface IntradayProfileBackupSection {
  intradayProfiles: IntradayProfileBackupEntry[];
}

export interface IntradayProfileBackupCounts {
  intradayProfiles: number;
}

/**
 * Build the intraday-shape slice of a user's full backup.
 *
 * Takes the delegate it uses rather than a whole `PrismaClient`, matching
 * `buildProfileBackupSection` and `buildCycleBackupSection`, so the route's
 * global client and the worker's local one share one read.
 */
export async function buildIntradayProfileBackupSection(
  prisma: Pick<PrismaClient, "intradayCumulativeProfile">,
  userId: string,
  options: IntradayProfileBackupOptions = {},
): Promise<IntradayProfileBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";

  // The table carries no tombstone — the retention prune hard-deletes — so
  // both purposes read the same set and only identity differs.
  const rows = await prisma.intradayCumulativeProfile.findMany({
    where: { userId },
    orderBy: [{ dateKey: "desc" }, { type: "asc" }],
  });

  return {
    intradayProfiles: rows.map((row) => ({
      ...(disasterRecovery
        ? {
            id: row.id,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          }
        : {}),
      type: row.type,
      dateKey: row.dateKey,
      hourlyCumulative: row.hourlyCumulative,
      dayTotal: row.dayTotal,
      sampleCount: row.sampleCount,
      timezone: row.timezone,
    })),
  };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countIntradayProfileBackupSection(
  section: IntradayProfileBackupSection,
): IntradayProfileBackupCounts {
  return { intradayProfiles: section.intradayProfiles.length };
}

/** Counts the intraday restore wiped, for the audit trail. */
export interface IntradayProfileRestoreCleared {
  intradayProfiles: number;
}

/**
 * The slice of a parsed backup this restore consumes.
 *
 * Required rather than optional: `BackupPayload` defaults it, so every caller
 * already satisfies this, and a caller that stops satisfying it fails to
 * compile instead of passing `undefined` into a loop that iterates zero times
 * and reports success.
 */
export interface IntradayProfileRestoreInput {
  intradayProfiles: IntradayProfileBackupEntry[];
}

/**
 * Re-create the account's stored day curves.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section. There is no parent to resolve — the owner is the only reference and
 * it comes from the target account — so the two ways this can go wrong are
 * both about the row itself, and both throw rather than skip:
 *
 *   - two rows claiming the same `(type, dateKey)`, which the unique index
 *     would reject with a constraint name instead of a sentence, and
 *   - a curve that is not 24 hours long, which inserts cleanly and is then
 *     dropped by every reader, so the day would be present in the table and
 *     absent from the feature.
 *
 * Absence must read as absence. A `.filter(Boolean)` here is how the last one
 * of these stayed invisible for three releases.
 */
export async function restoreIntradayProfileData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: IntradayProfileRestoreInput,
): Promise<IntradayProfileRestoreCleared> {
  const cleared = await tx.intradayCumulativeProfile.deleteMany({
    where: { userId: ownerId },
  });

  const seen = new Set<string>();
  for (const profile of payload.intradayProfiles) {
    const key = `${profile.type}\0${profile.dateKey}`;
    if (seen.has(key)) {
      throw new Error(
        `Duplicate intraday profile for ${profile.type} on ${profile.dateKey}. ` +
          "One account has at most one curve per metric per local day, and " +
          "picking a winner here would silently discard the other day's shape.",
      );
    }
    seen.add(key);

    if (profile.hourlyCumulative.length !== PROFILE_BACKUP_HOURS) {
      throw new Error(
        `Intraday profile for ${profile.type} on ${profile.dateKey} carries ` +
          `${profile.hourlyCumulative.length} hourly slots, not ${PROFILE_BACKUP_HOURS}. ` +
          "Restoring it would write a row the same-time baseline drops on read, " +
          "so the day would be in the table and missing from the feature.",
      );
    }
  }

  if (payload.intradayProfiles.length > 0) {
    await tx.intradayCumulativeProfile.createMany({
      data: payload.intradayProfiles.map((profile) => ({
        ...(profile.id ? { id: profile.id } : {}),
        userId: ownerId,
        type: profile.type,
        dateKey: profile.dateKey,
        hourlyCumulative: profile.hourlyCumulative,
        dayTotal: profile.dayTotal,
        sampleCount: profile.sampleCount,
        timezone: profile.timezone,
        ...(profile.createdAt
          ? { createdAt: new Date(profile.createdAt) }
          : {}),
        ...(profile.updatedAt
          ? { updatedAt: new Date(profile.updatedAt) }
          : {}),
      })),
    });
  }

  return { intradayProfiles: cleared.count };
}
