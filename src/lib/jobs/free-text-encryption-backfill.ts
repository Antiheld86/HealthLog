/**
 * v1.39.3 — boot-time converging backfill that moves the last two readable
 * free-text columns to AES-256-GCM at rest:
 * `CoachConversation.title` -> `titleEncrypted` (the opening words of the
 * first Coach message, or a rename) and
 * `CustomMetricEntry.note` -> `noteEncrypted`.
 *
 * v1.39.4 extends the same pass to three more columns that are not free text
 * in the narrow sense but just as personal:
 * `Practitioner.phone` -> `phoneEncrypted`,
 * `Practitioner.location` -> `locationEncrypted` (the address book of doctors
 * and practices), and `WorkoutRoute.geometry` -> `geometryEncrypted` (the GPS
 * track of an outdoor workout, sealed as one binary value). A route row has no
 * user id of its own; it is found through its workout.
 *
 * Modelled on `med-notes-encryption-backfill.ts`: a discovery query enqueues
 * one job per user still holding an un-migrated row, the per-user handler walks
 * that user's rows, and the pass is idempotent across reboots — once a row is
 * migrated it drops off the discovery + candidate sets.
 *
 * DATA-LOSS SAFETY:
 *  - Per row, the encrypt-then-null happens in a SINGLE interactive
 *    transaction guarded by a re-read inside the tx, so the readable column is
 *    only nulled AFTER the ciphertext is written in the same atomic unit. A
 *    row that had text is never left with neither.
 *  - FAIL-CLOSED: the encryption helper throws on a missing / malformed key.
 *    The throw aborts the transaction (the row is untouched) and propagates so
 *    pg-boss retries.
 *  - IDEMPOTENT: the guard (readable column IS NOT NULL) is re-checked inside
 *    the tx, so a re-run, or two workers racing, migrates a row at most once;
 *    a second pass migrates zero rows.
 *  - The guard is the readable column alone, not "and no ciphertext yet".
 *    From this release on nothing writes the readable column, so a row holding
 *    both can only come from a writer of the previous release still running
 *    after the upgrade (a rename, an edited note). Its readable value is then
 *    the newer one, and it is the one sealed.
 *
 * The readable columns are NOT dropped in this release. That is a follow-up
 * release, once this backfill reports zero remaining rows on every instance;
 * every one of them carries the marker in `schema.prisma`.
 *
 * Boot discovery is staggered past the startup storm (`startAfter`), like the
 * other boot backfills; the daily discovery tick passes no offset.
 *
 * The queue name MUST be registered in the maintenance registrar
 * (`src/lib/jobs/reminder/register-maintenance.ts`) so pg-boss provisions it at
 * boot; an unregistered queue silently never drains.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { encryptRouteGeometry } from "@/lib/workouts/route-geometry-cipher";

export const FREE_TEXT_ENCRYPTION_BACKFILL_QUEUE =
  "free-text-encryption-backfill";

/** Serial — one transaction per row, kept off the request pool. */
export const FREE_TEXT_ENCRYPTION_BACKFILL_CONCURRENCY = 1;

/** How many candidate rows to pull per page within a user's pass. */
const PAGE_SIZE = 200;

export interface FreeTextEncryptionBackfillPayload {
  /** Absent on the daily discovery tick; present for a per-user job. */
  userId?: string;
  enqueuedAt?: string;
}

export interface FreeTextEncryptionBackfillSummary {
  conversationTitlesMigrated: number;
  metricNotesMigrated: number;
  /** v1.39.4 — practitioners whose phone and/or address were sealed. */
  practitionerContactsMigrated: number;
  /** v1.39.4 — workout GPS tracks sealed. */
  routeGeometriesMigrated: number;
}

/**
 * Migrate one conversation's readable title into `titleEncrypted` and null the
 * readable column, atomically and idempotently. Returns true if it changed the
 * row, false if a concurrent pass already did.
 */
async function migrateConversationTitle(id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.coachConversation.findUnique({
      where: { id },
      select: { title: true },
    });
    if (!fresh || fresh.title === null) return false;
    // FAIL-CLOSED: a key error throws here and rolls the tx back.
    await tx.coachConversation.update({
      where: { id },
      data: { titleEncrypted: encryptToBytes(fresh.title), title: null },
    });
    return true;
  });
}

/**
 * Migrate one custom-metric reading's readable note into `noteEncrypted` and
 * null the readable column, atomically and idempotently.
 */
async function migrateMetricNote(id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.customMetricEntry.findUnique({
      where: { id },
      select: { note: true },
    });
    if (!fresh || fresh.note === null) return false;
    await tx.customMetricEntry.update({
      where: { id },
      // An empty note reads back as "no note" either way, so it stores none.
      data: { noteEncrypted: encryptNote(fresh.note), note: null },
    });
    return true;
  });
}

/**
 * Migrate one practitioner's readable phone number and address into their
 * ciphertext columns and null the readable ones, atomically and idempotently.
 * A field that is already NULL keeps whatever ciphertext it has.
 */
async function migratePractitionerContact(id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.practitioner.findUnique({
      where: { id },
      select: { phone: true, location: true },
    });
    if (!fresh || (fresh.phone === null && fresh.location === null)) {
      return false;
    }
    await tx.practitioner.update({
      where: { id },
      data: {
        ...(fresh.phone !== null
          ? { phoneEncrypted: encryptNote(fresh.phone), phone: null }
          : {}),
        ...(fresh.location !== null
          ? { locationEncrypted: encryptNote(fresh.location), location: null }
          : {}),
      },
    });
    return true;
  });
}

/**
 * Migrate one workout's readable GPS track into `geometryEncrypted` and null
 * the readable column, atomically and idempotently.
 */
async function migrateRouteGeometry(id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.workoutRoute.findUnique({
      where: { id },
      select: { geometry: true },
    });
    if (!fresh || fresh.geometry === null) return false;
    await tx.workoutRoute.update({
      where: { id },
      data: {
        geometryEncrypted: encryptRouteGeometry(fresh.geometry),
        geometry: Prisma.DbNull,
      },
    });
    return true;
  });
}

/**
 * Walk one kind of row page by page, migrating each. `page` returns the ids
 * still holding a readable value; each migration clears it, so a migrated row
 * drops out of the next page. A page where nothing moved (every row taken by
 * a racing worker) ends the loop, so it always terminates.
 */
async function drain(
  page: () => Promise<{ id: string }[]>,
  migrate: (id: string) => Promise<boolean>,
  once: (id: string) => void,
): Promise<number> {
  let migrated = 0;
  for (;;) {
    const rows = await page();
    if (rows.length === 0) break;
    let migratedThisPage = 0;
    for (const { id } of rows) {
      once(id);
      if (await migrate(id)) {
        migrated += 1;
        migratedThisPage += 1;
      }
    }
    if (migratedThisPage === 0) break;
  }
  return migrated;
}

/**
 * Per-user queue handler. Walks every un-migrated title and note of one
 * account and migrates each in its own transaction. Safe to re-run.
 */
export async function runFreeTextEncryptionBackfillForUser(
  userId: string,
): Promise<FreeTextEncryptionBackfillSummary> {
  // Every row this pass has sealed. A row that comes back on a later page was
  // not cleared, so the pass would never converge; it stops loudly instead of
  // re-sealing the same rows forever.
  const sealed = new Set<string>();
  const once = (id: string) => {
    if (sealed.has(id)) {
      throw new Error(
        `free-text encryption backfill: row ${id} still readable after sealing`,
      );
    }
    sealed.add(id);
  };

  const conversationTitlesMigrated = await drain(
    () =>
      prisma.coachConversation.findMany({
        where: { userId, title: { not: null } },
        select: { id: true },
        take: PAGE_SIZE,
      }),
    migrateConversationTitle,
    once,
  );
  const metricNotesMigrated = await drain(
    () =>
      prisma.customMetricEntry.findMany({
        where: { userId, note: { not: null } },
        select: { id: true },
        take: PAGE_SIZE,
      }),
    migrateMetricNote,
    once,
  );
  const practitionerContactsMigrated = await drain(
    () =>
      prisma.practitioner.findMany({
        where: {
          userId,
          OR: [{ phone: { not: null } }, { location: { not: null } }],
        },
        select: { id: true },
        take: PAGE_SIZE,
      }),
    migratePractitionerContact,
    once,
  );
  // A track is the one large value here. The page holds ids only; each track
  // is read inside its own transaction, so no more than one is in memory.
  const routeGeometriesMigrated = await drain(
    () =>
      prisma.workoutRoute.findMany({
        where: { workout: { userId }, geometry: { not: Prisma.DbNull } },
        select: { id: true },
        take: PAGE_SIZE,
      }),
    migrateRouteGeometry,
    once,
  );

  annotate({
    action: {
      name: "free_text.encryption.backfill",
      details: {
        conversation_titles_migrated: conversationTitlesMigrated,
        metric_notes_migrated: metricNotesMigrated,
        practitioner_contacts_migrated: practitionerContactsMigrated,
        route_geometries_migrated: routeGeometriesMigrated,
      },
    },
  });

  return {
    conversationTitlesMigrated,
    metricNotesMigrated,
    practitionerContactsMigrated,
    routeGeometriesMigrated,
  };
}

/**
 * Discovery. Finds every user still holding a readable value in any of the
 * columns above and enqueues one backfill job per account. The 0357 and 0361
 * partial indexes match the predicates, so the scan is index-only and converges to empty. pg-boss
 * `singletonKey` coalesces duplicate sends. Best-effort: errors come back
 * through the result value so worker boot never fails on a miss.
 */
export async function enqueueBootTimeFreeTextEncryptionBackfill(
  // Boot-storm stagger in seconds; 0 (the cron tick) keeps immediate semantics.
  startAfterSeconds: number = 0,
): Promise<{ enqueued: number; skipped: number; error: string | null }> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    const found = await Promise.all([
      prisma.$queryRaw<{ user_id: string }[]>`
        SELECT DISTINCT user_id FROM coach_conversations
        WHERE title IS NOT NULL`,
      prisma.$queryRaw<{ user_id: string }[]>`
        SELECT DISTINCT user_id FROM custom_metric_entries
        WHERE note IS NOT NULL`,
      prisma.$queryRaw<{ user_id: string }[]>`
        SELECT DISTINCT user_id FROM practitioners
        WHERE phone IS NOT NULL OR location IS NOT NULL`,
      prisma.$queryRaw<{ user_id: string }[]>`
        SELECT DISTINCT w.user_id FROM workout_routes r
        JOIN workouts w ON w.id = r.workout_id
        WHERE r.geometry IS NOT NULL`,
    ]);

    const userIds = new Set<string>();
    for (const rows of found) {
      for (const { user_id } of rows) userIds.add(user_id);
    }

    let enqueued = 0;
    let skipped = 0;
    for (const userId of userIds) {
      const payload: FreeTextEncryptionBackfillPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        FREE_TEXT_ENCRYPTION_BACKFILL_QUEUE,
        payload,
        {
          retryLimit: 5,
          retryDelay: 60,
          retryBackoff: true,
          singletonKey: `free-text-encryption-backfill|${userId}`,
          ...(startAfterSeconds > 0 ? { startAfter: startAfterSeconds } : {}),
        },
      );
      if (jobId) {
        enqueued += 1;
      } else {
        skipped += 1;
      }
    }
    return { enqueued, skipped, error: null };
  } catch (err) {
    return {
      enqueued: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
