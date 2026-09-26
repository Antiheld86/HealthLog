/**
 * v1.19.2 — server-authoritative measurement capture from the Telegram bot.
 *
 * The HTTP measurement-create path (`POST /api/measurements`) is bound to a
 * cookie/Bearer session via `requireAuth`; the Telegram webhook resolves the
 * user from the linked chat instead. This helper holds the shared write so
 * the two entry points agree on the canonical shape: the same range guard,
 * the same canonical unit, the same cache invalidation + DAY-rollup
 * recompute the manual route fires. `source` is pinned to the `TELEGRAM`
 * `MeasurementSource` value (added in migration 0189).
 *
 * The `userId` is NEVER taken from the Telegram payload — the caller passes
 * the id it resolved from the stored `telegramChatId` binding. The capture
 * is correlated to a specific `MeasurementReminder` (carrying the expected
 * `measurementType`) through a `TelegramPromptContext` row, so a numeric
 * reply can only ever land the metric that reminder asked for, for that
 * user. BP (two values) is out of scope for the single-numeric-reply path.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import {
  getUnitForType,
  validateMeasurementRange,
} from "@/lib/validations/measurement";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";

/**
 * The single-value measurement types a numeric Telegram reply can capture.
 *
 * Excludes BLOOD_PRESSURE_SYS — a BP reading needs systolic AND diastolic,
 * which a single numeric reply can't express unambiguously. The BP reminder
 * keeps its existing satisfy-only "done" flow; a value capture for it is a
 * documented follow-up (a guided two-number prompt).
 */
const TELEGRAM_CAPTURABLE_TYPES: ReadonlySet<MeasurementType> =
  new Set<MeasurementType>([
    "WEIGHT",
    "PULSE",
    "BLOOD_GLUCOSE",
    "OXYGEN_SATURATION",
    "BODY_TEMPERATURE",
    "BODY_FAT",
    "FAT_MASS",
    "FAT_FREE_MASS",
    "MUSCLE_MASS",
    "LEAN_BODY_MASS",
    "BONE_MASS",
    "TOTAL_BODY_WATER",
    "VISCERAL_FAT",
    "BODY_MASS_INDEX",
  ]);

/**
 * True when a numeric Telegram reply can capture a Measurement for this
 * reminder's target type. The webhook gates the value-prompt on this so a
 * BP reminder (or a free-text Vorsorge with no `measurementType`) never
 * offers an ambiguous numeric capture.
 */
export function isTelegramCapturableType(
  type: MeasurementType | null | undefined,
): type is MeasurementType {
  return type != null && TELEGRAM_CAPTURABLE_TYPES.has(type);
}

export interface TelegramMeasurementResult {
  /** `ok` — a row was written (or already existed under the dedup key).
   *  `invalid_number` — the reply did not parse to a finite number.
   *  `out_of_range` — the value fell outside the type's plausible range.
   *  `unsupported_type` — the type is not single-value capturable. */
  status: "ok" | "invalid_number" | "out_of_range" | "unsupported_type";
}

/**
 * Parse a free-text Telegram reply into a finite number. Tolerates a
 * comma decimal separator (de-DE keyboards) and surrounding whitespace;
 * rejects anything with trailing non-numeric noise so "72 bpm" doesn't
 * silently capture 72.
 */
export function parseTelegramNumber(text: string): number | null {
  const normalised = text.trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(normalised)) return null;
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}

/**
 * Capture a measurement on behalf of a Telegram-linked user from a numeric
 * reply to a measurement-reminder prompt.
 *
 * Idempotent on `externalId` (the per-prompt key the caller derives from
 * `telegram:measure:<chatId>:<promptMsgId>`): a redelivered reply converges
 * onto the same row via the `(userId, type, source, externalId)` unique
 * instead of minting a duplicate.
 */
export async function logTelegramMeasurement(input: {
  userId: string;
  type: MeasurementType;
  rawText: string;
  tz: string | null;
  /** Stable per-prompt id for Telegram redelivery dedup. */
  externalId: string;
  client?: PrismaClient | Prisma.TransactionClient;
}): Promise<TelegramMeasurementResult> {
  const prisma = (input.client ?? defaultPrisma) as PrismaClient;

  if (!isTelegramCapturableType(input.type)) {
    return { status: "unsupported_type" };
  }

  const value = parseTelegramNumber(input.rawText);
  if (value === null) {
    return { status: "invalid_number" };
  }

  if (validateMeasurementRange(input.type, value) !== null) {
    return { status: "out_of_range" };
  }

  const measuredAt = new Date();

  const existing = await prisma.measurement.findUnique({
    where: {
      userId_type_source_externalId: {
        userId: input.userId,
        type: input.type,
        source: "TELEGRAM",
        externalId: input.externalId,
      },
    },
    select: { id: true },
  });
  if (existing) {
    return { status: "ok" };
  }

  const created = await prisma.measurement.create({
    data: {
      userId: input.userId,
      type: input.type,
      value,
      unit: getUnitForType(input.type),
      source: "TELEGRAM",
      measuredAt,
      externalId: input.externalId,
    },
    select: { id: true, type: true, measuredAt: true },
  });

  void emitInsertedMeasurementArrivals(
    input.userId,
    [created],
    "telegram",
  ).catch(() => {});

  invalidateUserMeasurements(input.userId, { evict: true });

  // Rollup refresh plus the status re-warm, both best-effort — a cache
  // tier, never a write-path invariant.
  await afterMeasurementMutation(
    input.userId,
    [{ type: input.type, measuredAt }],
    "telegram-measurement",
  );

  return { status: "ok" };
}
