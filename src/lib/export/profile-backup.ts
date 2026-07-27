/**
 * Durable self-context and user-defined metrics — both ends in one file.
 *
 * Two models classified `BACKED_UP` since `backup-plan.ts` was written and
 * carried by nothing: `UserHealthProfile` (what a person told the app is
 * durably true of them) and `CustomMetric` / `CustomMetricEntry` (a series the
 * person defined themselves, which by definition no integration can re-sync).
 * The custom-metric gap is live data loss today: a restore rebuilt the account
 * without the metric or a single one of its readings and reported success.
 *
 * The builder and the restore live together deliberately, the way
 * `src/lib/cycle/backup.ts` does. A reader asking "is this carried at both
 * ends?" answers it in one file, and — the reason it matters — a reader who
 * greps only the restore ROUTE gets a false negative, because the route
 * delegates. That mistake has already been made once about the cycle data and
 * had to be retracted; keeping the pair adjacent is what makes the answer
 * cheap enough to get right.
 *
 * Encrypted columns follow the established split. A portable export is the
 * human-readable artefact, so the profile's free text is decrypted into it. A
 * disaster-recovery payload carries the AES-256-GCM envelope verbatim as
 * base64 and never decrypts, so the same instance's key reads it back
 * unchanged and no plaintext is duplicated into the file.
 */
import { Buffer } from "node:buffer";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { getEvent } from "@/lib/logging/context";

export interface ProfileBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/**
 * The account's durable self-context. One row per user, so there is no
 * reference to resolve on the way back in — the owner is the key.
 */
export interface HealthProfileBackupEntry {
  /** Present in canonical DR payloads so the row keeps a stable identity. */
  id?: string;
  /**
   * Portable exports carry the decrypted text; DR payloads carry `null` here
   * and the ciphertext below. Never both — a DR file must not duplicate the
   * plaintext of a column it is already carrying encrypted.
   */
  aboutMe: string | null;
  conditions: string | null;
  allergies: string | null;
  coachFocus: string | null;
  /** Base64 of the already-encrypted BYTEA value. DR payloads only. */
  aboutMeEncrypted?: string | null;
  conditionsEncrypted?: string | null;
  allergiesEncrypted?: string | null;
  coachFocusEncrypted?: string | null;
  /**
   * Server-derived clarifying questions awaiting an answer, encrypted JSON.
   *
   * DR only, and deliberately: they are not the person's own words, they are
   * regenerated after the next profile save, and a portable export that is
   * meant to be readable gains nothing from an opaque envelope. Carried in the
   * canonical payload because a DR restore should land the account in the
   * state it was in, pending prompts included.
   */
  pendingQuestionsEncrypted?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** One reading of a user-defined metric. */
export interface CustomMetricEntryBackupEntry {
  /** Present in canonical DR payloads so the row keeps a stable identity. */
  id?: string;
  value: number;
  /** Unit snapshot taken from the metric at write time, not a live join. */
  unit: string;
  measuredAt: string;
  note: string | null;
  createdAt?: string;
}

/**
 * A metric the account defined, with its readings nested inside it.
 *
 * Nested rather than a flat array keyed by metric name, and that is a
 * deliberate difference from the intake-event section next door. A flat array
 * needs the restore to resolve every row's parent by a natural key, which is
 * the exact shape that produces a lookup miss — and a lookup miss is a row
 * that either vanishes quietly or stops the restore. Nesting removes the
 * reference, so an entry cannot dangle and there is nothing to drop.
 */
export interface CustomMetricBackupEntry {
  /** Present in canonical DR payloads so the row keeps a stable identity. */
  id?: string;
  name: string;
  unit: string;
  targetLow: number | null;
  targetHigh: number | null;
  decimals: number | null;
  description: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** Tombstone, DR payloads only — a portable export never carries deleted rows. */
  deletedAt?: string | null;
  entries: CustomMetricEntryBackupEntry[];
}

export interface ProfileBackupSection {
  healthProfile: HealthProfileBackupEntry | null;
  customMetrics: CustomMetricBackupEntry[];
}

export interface ProfileBackupCounts {
  healthProfile: number;
  customMetrics: number;
  customMetricEntries: number;
}

/**
 * Decrypt one profile field fail-soft.
 *
 * Fail-soft here and NOT on the restore side, which is the asymmetry that
 * matters: a field this instance can no longer read is already lost, and
 * refusing to build the rest of the backup over it would turn one unreadable
 * column into no backup at all. The warning rides the wide event so the
 * operator sees it. On the way back in, by contrast, an unresolvable
 * reference throws — absence must read as absence, not as a quiet drop.
 */
function decryptProfileFieldSoft(
  buf: Uint8Array | null,
  field: string,
): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decryptFromBytes(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `health profile ${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

function toBase64(buf: Uint8Array | null): string | null {
  return buf && buf.byteLength > 0 ? Buffer.from(buf).toString("base64") : null;
}

/**
 * Build the profile + custom-metric slice of a user's full backup.
 *
 * Takes the delegates it uses rather than a whole `PrismaClient` so the route's
 * global client and the worker's local one share one read, matching
 * `buildCycleBackupSection` and `buildRecordsBackupSection`.
 */
export async function buildProfileBackupSection(
  prisma: Pick<PrismaClient, "userHealthProfile" | "customMetric">,
  userId: string,
  options: ProfileBackupOptions = {},
): Promise<ProfileBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";

  const [profileRow, metricRows] = await Promise.all([
    prisma.userHealthProfile.findUnique({ where: { userId } }),
    prisma.customMetric.findMany({
      // A portable export never resurrects a tombstone; a DR payload restores
      // the account exactly as it stood, deletions included.
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      orderBy: { name: "asc" },
      include: {
        // `CustomMetricEntry` carries no tombstone of its own — a deleted
        // metric cascades its readings away — so both purposes read the same
        // set and only the parent filter differs.
        entries: { orderBy: { measuredAt: "asc" } },
      },
    }),
  ]);

  const healthProfile: HealthProfileBackupEntry | null = profileRow
    ? disasterRecovery
      ? {
          id: profileRow.id,
          aboutMe: null,
          conditions: null,
          allergies: null,
          coachFocus: null,
          aboutMeEncrypted: toBase64(profileRow.aboutMeEncrypted),
          conditionsEncrypted: toBase64(profileRow.conditionsEncrypted),
          allergiesEncrypted: toBase64(profileRow.allergiesEncrypted),
          coachFocusEncrypted: toBase64(profileRow.coachFocusEncrypted),
          pendingQuestionsEncrypted: toBase64(
            profileRow.pendingQuestionsEncrypted,
          ),
          createdAt: profileRow.createdAt.toISOString(),
          updatedAt: profileRow.updatedAt.toISOString(),
        }
      : {
          aboutMe: decryptProfileFieldSoft(
            profileRow.aboutMeEncrypted,
            "aboutMe",
          ),
          conditions: decryptProfileFieldSoft(
            profileRow.conditionsEncrypted,
            "conditions",
          ),
          allergies: decryptProfileFieldSoft(
            profileRow.allergiesEncrypted,
            "allergies",
          ),
          coachFocus: decryptProfileFieldSoft(
            profileRow.coachFocusEncrypted,
            "coachFocus",
          ),
        }
    : null;

  const customMetrics: CustomMetricBackupEntry[] = metricRows.map((metric) => ({
    ...(disasterRecovery
      ? {
          id: metric.id,
          createdAt: metric.createdAt.toISOString(),
          updatedAt: metric.updatedAt.toISOString(),
          deletedAt: metric.deletedAt?.toISOString() ?? null,
        }
      : {}),
    name: metric.name,
    unit: metric.unit,
    targetLow: metric.targetLow,
    targetHigh: metric.targetHigh,
    decimals: metric.decimals,
    description: metric.description,
    entries: metric.entries.map((entry) => ({
      ...(disasterRecovery
        ? {
            id: entry.id,
            createdAt: entry.createdAt.toISOString(),
          }
        : {}),
      value: entry.value,
      unit: entry.unit,
      measuredAt: entry.measuredAt.toISOString(),
      note: entry.note,
    })),
  }));

  return { healthProfile, customMetrics };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countProfileBackupSection(
  section: ProfileBackupSection,
): ProfileBackupCounts {
  return {
    healthProfile: section.healthProfile ? 1 : 0,
    customMetrics: section.customMetrics.length,
    customMetricEntries: section.customMetrics.reduce(
      (sum, metric) => sum + metric.entries.length,
      0,
    ),
  };
}

/** Counts the profile restore wiped, for the audit trail. */
export interface ProfileRestoreCleared {
  healthProfile: number;
  customMetrics: number;
}

/**
 * The slice of a parsed backup this restore consumes.
 *
 * Both fields are REQUIRED rather than optional. `BackupPayload` defaults them,
 * so every caller already satisfies this — and a caller that stops satisfying
 * it fails to compile instead of passing `undefined` into a loop that iterates
 * zero times and reports success.
 */
export interface ProfileRestoreInput {
  healthProfile: HealthProfileBackupEntry | null;
  customMetrics: CustomMetricBackupEntry[];
}

/**
 * Decode a base64 ciphertext field, refusing a value that is not decodable
 * rather than writing an envelope no key can ever open.
 */
function decodeEncryptedField(
  encoded: string,
  field: string,
): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength === 0) {
    throw new Error(
      `Health profile field '${field}' carries an unreadable ciphertext value. ` +
        "Restoring it would write an envelope no key can open, which reads as " +
        "a present-but-empty answer rather than as the missing one it is.",
    );
  }
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
}

/**
 * Resolve one encrypted profile column from the payload.
 *
 * Mirrors the lab-note contract: ciphertext wins when the DR payload carried
 * it, plaintext is re-encrypted when a portable export carried that instead,
 * and an absent column comes back absent.
 */
function resolveProfileColumn(
  ciphertext: string | null | undefined,
  plaintext: string | null,
  field: string,
): Uint8Array<ArrayBuffer> | null {
  if (ciphertext !== undefined) {
    return ciphertext === null ? null : decodeEncryptedField(ciphertext, field);
  }
  return plaintext == null ? null : encryptToBytes(plaintext);
}

/**
 * Re-create the account's self-context and user-defined metrics.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section. The metric delete cascades its entries, so the readings are wiped
 * and rebuilt with their parent rather than orphaned against it.
 */
export async function restoreProfileData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: ProfileRestoreInput,
): Promise<ProfileRestoreCleared> {
  const profileCleared = await tx.userHealthProfile.deleteMany({
    where: { userId: ownerId },
  });
  const metricsCleared = await tx.customMetric.deleteMany({
    where: { userId: ownerId },
  });

  if (payload.healthProfile) {
    const p = payload.healthProfile;
    await tx.userHealthProfile.create({
      data: {
        ...(p.id ? { id: p.id } : {}),
        userId: ownerId,
        aboutMeEncrypted: resolveProfileColumn(
          p.aboutMeEncrypted,
          p.aboutMe,
          "aboutMe",
        ),
        conditionsEncrypted: resolveProfileColumn(
          p.conditionsEncrypted,
          p.conditions,
          "conditions",
        ),
        allergiesEncrypted: resolveProfileColumn(
          p.allergiesEncrypted,
          p.allergies,
          "allergies",
        ),
        coachFocusEncrypted: resolveProfileColumn(
          p.coachFocusEncrypted,
          p.coachFocus,
          "coachFocus",
        ),
        // Portable exports do not carry the pending questions at all, so
        // `undefined` means "this file has nothing to say" and the account
        // comes back with no prompts pending — which the next profile save
        // regenerates. Only a DR payload can restore them.
        pendingQuestionsEncrypted:
          p.pendingQuestionsEncrypted == null
            ? null
            : decodeEncryptedField(
                p.pendingQuestionsEncrypted,
                "pendingQuestions",
              ),
        ...(p.createdAt ? { createdAt: new Date(p.createdAt) } : {}),
        ...(p.updatedAt ? { updatedAt: new Date(p.updatedAt) } : {}),
      },
    });
  }

  // `(userId, name)` is unique, so two metrics sharing a name in one file
  // would collide on insert and abort the transaction with a constraint error
  // that names a column rather than the problem. Say what is wrong instead.
  const seenNames = new Set<string>();
  for (const metric of payload.customMetrics) {
    if (seenNames.has(metric.name)) {
      throw new Error(
        `Duplicate custom metric name: ${metric.name}. ` +
          "A backup cannot carry two metrics with the same name for one " +
          "account, and picking a winner here would silently discard the " +
          "readings of the other.",
      );
    }
    seenNames.add(metric.name);

    await tx.customMetric.create({
      data: {
        ...(metric.id ? { id: metric.id } : {}),
        userId: ownerId,
        name: metric.name,
        unit: metric.unit,
        targetLow: metric.targetLow,
        targetHigh: metric.targetHigh,
        decimals: metric.decimals,
        description: metric.description,
        ...(metric.createdAt ? { createdAt: new Date(metric.createdAt) } : {}),
        ...(metric.updatedAt ? { updatedAt: new Date(metric.updatedAt) } : {}),
        deletedAt: metric.deletedAt ? new Date(metric.deletedAt) : null,
        entries: {
          create: metric.entries.map((entry) => ({
            ...(entry.id ? { id: entry.id } : {}),
            userId: ownerId,
            value: entry.value,
            unit: entry.unit,
            measuredAt: new Date(entry.measuredAt),
            note: entry.note,
            ...(entry.createdAt
              ? { createdAt: new Date(entry.createdAt) }
              : {}),
          })),
        },
      },
    });
  }

  return {
    healthProfile: profileCleared.count,
    customMetrics: metricsCleared.count,
  };
}
