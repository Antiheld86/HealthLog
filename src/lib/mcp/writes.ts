/**
 * MCP write data cores — in-process measurement + mood logging.
 *
 * These mirror the proven server-authoritative Telegram capture helpers
 * (`src/lib/measurements/create-from-telegram.ts`,
 * `src/lib/mood/create-from-telegram.ts`) one-for-one — same range guard,
 * same canonical unit, same cache invalidation + rollup recompute — but pin
 * `source` to the dedicated `MCP` provenance and use an MCP idempotency
 * namespace. The two surfaces are kept as deliberate parallels rather than a
 * shared core so a future change to one cannot silently alter the other's
 * validation or dedup contract.
 *
 * `userId` is ALWAYS the resolved session id (`McpAuthContext.userId`), never
 * a caller-supplied field. The write tools (`src/lib/mcp/write-tools.ts`) own
 * the confirm gate; these cores only execute a confirmed write.
 */
import { createHash } from "node:crypto";

import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { auditLog } from "@/lib/auth/audit";
import { encryptNote, readNote } from "@/lib/crypto/note-cipher";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  getUnitForType,
  validateMeasurementRange,
} from "@/lib/validations/measurement";
import { resolveToCanonicalUnit } from "@/lib/measurements/unit-aliases";
import {
  isPlausibleEntryInstant,
  ENTRY_INSTANT_CLOCK_SKEW_MS,
} from "@/lib/validations/entry-instant";
import { isTelegramCapturableType } from "@/lib/measurements/create-from-telegram";
import {
  invalidateUserMeasurements,
  invalidateUserMood,
} from "@/lib/cache/invalidate";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";
import { MOOD_ENUM_BY_SCORE } from "@/lib/mood/labels";
import { getScoreForMood } from "@/lib/validations/mood";
import { moodDateKey, DEFAULT_TIMEZONE } from "@/lib/mood/date-key";
import { deriveA1 } from "@/lib/mood/level-a";
import {
  classifyExternalId,
  unstableExternalIdMessage,
  unstableExternalIdMeta,
  IDEMPOTENCY_KEY_LABEL,
} from "@/lib/validations/external-id";

/** The MCP write provenance — distinct from MANUAL / TELEGRAM. */
const MCP_SOURCE = "MCP" as const;

/**
 * Derive the stable per-write `externalId` from the caller's idempotency key.
 * A SHA-256 hash keeps the column bounded and opaque regardless of how long
 * the assistant's key is, and gives the MCP writes their own dedup namespace
 * `(userId, type, MCP, externalId)` so a key can never collide with a
 * Telegram or manual row.
 */
/**
 * The MCP write key is an IDENTITY, not a windowed replay token: it is
 * hashed into the `externalId` half of `(userId, type, MCP, externalId)`
 * and matched forever. A key that changes between the preview call and
 * the commit call — or between two commits of the same logical write —
 * mints a second row instead of converging.
 *
 * The hash launders the shape, so the floor has to run on the INPUT: a
 * pointer-shaped key and a stable one both digest to clean hex, and the
 * `externalId` guard downstream could never tell them apart. The blank
 * case is the live one — every tool handler falls back to `""` when the
 * host omits the argument, and `""` digests to a CONSTANT, so every
 * keyless write after the first would report `already_logged` and be
 * silently dropped.
 */
function checkMcpIdempotencyKey(
  tool: string,
  idempotencyKey: string,
): { status: "unstable_idempotency_key"; reason: string } | null {
  const shape = classifyExternalId(idempotencyKey);
  if (shape === null) return null;
  annotate({
    action: { name: "mcp.tool.write" },
    meta: {
      tool,
      status: "unstable_idempotency_key",
      ...unstableExternalIdMeta(`mcp.${tool}`, [shape]),
    },
  });
  return {
    status: "unstable_idempotency_key",
    reason: unstableExternalIdMessage(shape, IDEMPOTENCY_KEY_LABEL),
  };
}

function mcpExternalId(
  prefix: "measure" | "mood" | "bp",
  idempotencyKey: string,
): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return `mcp:${prefix}:${digest}`;
}

/**
 * The structured refusal a pre-write validation can raise. `error` is the
 * stable machine code the write tool surfaces verbatim (`unsupported_type` /
 * `out_of_range`); `reason` carries the human-readable detail. Mirrors the
 * `{ status, reason }` the commit path already returns so a preview and a
 * commit reach the SAME verdict for the SAME input.
 */
export type McpWriteCheck =
  | { ok: true }
  | { ok: false; error: "unsupported_type" | "out_of_range"; reason?: string };

/**
 * Resolve a caller-supplied `unit` hint to the canonical unit + converted
 * value, or refuse it. Canonical storage is an invariant: an omitted hint
 * stamps the type's canonical unit; a recognised alias (lb/lbs/pound(s), in,
 * °F, mmol/L) converts the value and stamps canonical; anything else is
 * refused so a non-canonical unit is never persisted verbatim (the pre-fix
 * leak — a lb value tagged "kg" corrupts every display surface that trusts
 * the row's `unit` column). Shared by the confirm-gate preview and the commit
 * core so both reach one verdict for the same input.
 */
export type McpUnitResolution =
  { ok: true; value: number; unit: string } | { ok: false };

export function resolveMcpMeasurementUnit(
  type: MeasurementType,
  value: number,
  unit: string | undefined,
): McpUnitResolution {
  if (unit === undefined) {
    return { ok: true, value, unit: getUnitForType(type) };
  }
  const resolved = resolveToCanonicalUnit(type, value, unit);
  if (resolved === null) {
    return { ok: false };
  }
  return { ok: true, value: resolved.value, unit: resolved.unit };
}

/**
 * Bound a client-supplied `measuredAt` exactly like the manual measurement
 * route (`validateEntryInstant`): reject a future instant beyond the 5-min
 * clock-skew tolerance and anything before 1900. Returns the violation reason,
 * or null when the instant is plausible (or omitted — the core defaults to now).
 */
function instantRefusalReason(measuredAt: Date | undefined): string | null {
  if (measuredAt === undefined) return null;
  if (isPlausibleEntryInstant(measuredAt)) return null;
  if (measuredAt.getTime() > Date.now() + ENTRY_INSTANT_CLOCK_SKEW_MS) {
    return "Timestamp must not be in the future";
  }
  return "Timestamp must not predate 1900";
}

/**
 * Pure pre-write validation for a single-value measurement — the type
 * allowlist, the plausibility range, and the instant bound. Shared by the
 * commit core and the confirm-gate preview so a preview can never show a value
 * the commit would refuse.
 */
export function checkMcpMeasurement(
  type: MeasurementType,
  value: number,
  measuredAt: Date | undefined,
): McpWriteCheck {
  if (!isTelegramCapturableType(type)) {
    return { ok: false, error: "unsupported_type" };
  }
  const rangeError = validateMeasurementRange(type, value);
  if (rangeError !== null) {
    return { ok: false, error: "out_of_range", reason: rangeError };
  }
  const instantReason = instantRefusalReason(measuredAt);
  if (instantReason !== null) {
    return { ok: false, error: "out_of_range", reason: instantReason };
  }
  return { ok: true };
}

/**
 * Pure pre-write validation for a blood-pressure pair — both values'
 * plausibility ranges, the systolic > diastolic guard, and the instant bound.
 * Shared by the commit core and the confirm-gate preview.
 */
export function checkMcpBloodPressure(
  systolic: number,
  diastolic: number,
  measuredAt: Date | undefined,
): McpWriteCheck {
  const sysError = validateMeasurementRange("BLOOD_PRESSURE_SYS", systolic);
  const diaError = validateMeasurementRange("BLOOD_PRESSURE_DIA", diastolic);
  if (sysError !== null || diaError !== null) {
    return {
      ok: false,
      error: "out_of_range",
      reason: sysError ?? diaError ?? "Value out of range",
    };
  }
  // Plausibility: systolic is always the higher number.
  if (systolic <= diastolic) {
    return {
      ok: false,
      error: "out_of_range",
      reason: "Systolic must be greater than diastolic",
    };
  }
  const instantReason = instantRefusalReason(measuredAt);
  if (instantReason !== null) {
    return { ok: false, error: "out_of_range", reason: instantReason };
  }
  return { ok: true };
}

/** Normalized record echoed back to the assistant (preview + commit result). */
export interface McpMeasurementRecord {
  type: MeasurementType;
  value: number;
  unit: string;
  measuredAt: string;
  source: typeof MCP_SOURCE;
}

export type McpMeasurementResult =
  | { status: "unsupported_type" }
  | { status: "unsupported_unit" }
  | { status: "out_of_range"; reason: string }
  | { status: "unstable_idempotency_key"; reason: string }
  | { status: "written"; measurement: McpMeasurementRecord }
  | { status: "already_logged"; measurement: McpMeasurementRecord };

/**
 * Log one single-value measurement on behalf of the resolved MCP session.
 *
 * Mirrors `logTelegramMeasurement`: gates the type on the SAME
 * `isTelegramCapturableType` allowlist (the safe, user-loggable subset that
 * excludes COMPUTED / WHOOP / clinical-only types), validates the plausibility
 * range, and is idempotent on `(userId, type, MCP, externalId)`.
 */
export async function logMcpMeasurement(input: {
  userId: string;
  type: MeasurementType;
  value: number;
  unit?: string;
  measuredAt?: Date;
  idempotencyKey: string;
}): Promise<McpMeasurementResult> {
  const unstableKey = checkMcpIdempotencyKey(
    "log_measurement",
    input.idempotencyKey,
  );
  if (unstableKey) return unstableKey;

  // Normalise the caller's unit hint to canonical (converting the value) or
  // refuse it — a non-canonical unit must never be persisted verbatim. Runs
  // BEFORE the range check so the plausibility gate sees the canonical value
  // (e.g. 210 lb → 95.25 kg passes WEIGHT {1..500}).
  const unitResolution = resolveMcpMeasurementUnit(
    input.type,
    input.value,
    input.unit,
  );
  if (!unitResolution.ok) {
    annotate({
      action: { name: "mcp.tool.write" },
      meta: { tool: "log_measurement", status: "unsupported_unit" },
    });
    return { status: "unsupported_unit" };
  }
  const value = unitResolution.value;
  const unit = unitResolution.unit;

  // Same validation the confirm-gate preview runs (type allowlist, range, and
  // the measuredAt instant bound) — preview and commit reach one verdict.
  const check = checkMcpMeasurement(input.type, value, input.measuredAt);
  if (!check.ok) {
    annotate({
      action: { name: "mcp.tool.write" },
      meta: { tool: "log_measurement", status: check.error },
    });
    if (check.error === "unsupported_type") {
      return { status: "unsupported_type" };
    }
    return {
      status: "out_of_range",
      reason: check.reason ?? "Value out of range",
    };
  }

  const measuredAt = input.measuredAt ?? new Date();
  const externalId = mcpExternalId("measure", input.idempotencyKey);

  const record: McpMeasurementRecord = {
    type: input.type,
    value,
    unit,
    measuredAt: measuredAt.toISOString(),
    source: MCP_SOURCE,
  };

  const existing = await prisma.measurement.findUnique({
    where: {
      userId_type_source_externalId: {
        userId: input.userId,
        type: input.type,
        source: MCP_SOURCE,
        externalId,
      },
    },
    select: { id: true, value: true, unit: true, measuredAt: true },
  });
  if (existing) {
    annotate({
      action: { name: "mcp.tool.write" },
      meta: { tool: "log_measurement", status: "already_logged" },
    });
    return {
      status: "already_logged",
      measurement: {
        type: input.type,
        value: existing.value,
        unit: existing.unit ?? unit,
        measuredAt: existing.measuredAt.toISOString(),
        source: MCP_SOURCE,
      },
    };
  }

  // No mass assignment — every column is set explicitly from validated input.
  const created = await prisma.measurement.create({
    data: {
      userId: input.userId,
      type: input.type,
      value,
      unit,
      source: MCP_SOURCE,
      measuredAt,
      externalId,
    },
    select: { id: true, type: true, measuredAt: true },
  });

  void emitInsertedMeasurementArrivals(input.userId, [created], "mcp").catch(
    () => {},
  );

  invalidateUserMeasurements(input.userId, { evict: true });

  // Best-effort rollup refresh — a cache tier, never a write-path invariant.
  try {
    await recomputeBucketsForMeasurement(input.userId, input.type, measuredAt);
  } catch (rollupErr) {
    getEvent()?.addMeta(
      "mcp_measurement_rollup_failed",
      rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
    );
  }

  await auditLog("mcp.write.measurement", {
    userId: input.userId,
    details: {
      type: input.type,
      source: MCP_SOURCE,
      idempotencyKey: input.idempotencyKey,
    },
  });
  annotate({
    action: { name: "mcp.tool.write" },
    meta: { tool: "log_measurement", status: "written" },
  });

  return { status: "written", measurement: record };
}

/** Normalized blood-pressure record echoed back (preview + commit result). */
export interface McpBloodPressureRecord {
  systolic: number;
  diastolic: number;
  unit: string;
  measuredAt: string;
  source: typeof MCP_SOURCE;
}

export type McpBloodPressureResult =
  | { status: "out_of_range"; reason: string }
  | { status: "unstable_idempotency_key"; reason: string }
  | { status: "written"; bloodPressure: McpBloodPressureRecord }
  | { status: "already_logged"; bloodPressure: McpBloodPressureRecord };

/**
 * Log one blood-pressure reading on behalf of the resolved MCP session.
 *
 * BP is two values (systolic + diastolic) so it cannot go through the
 * single-value `logMcpMeasurement`. Both rows are written ATOMICALLY (one
 * transaction, the SAME `measuredAt`) and share one idempotency namespace: the
 * externalId is derived once from the caller's key and applied to both rows,
 * which stay distinct under the `(userId, type, source, externalId)` unique
 * because the type differs (SYS vs DIA). Each value is range-validated with the
 * same `validateMeasurementRange` the manual route uses, plus a systolic >
 * diastolic plausibility guard. No notes; `source` is pinned to `MCP`.
 */
export async function logMcpBloodPressure(input: {
  userId: string;
  systolic: number;
  diastolic: number;
  measuredAt?: Date;
  idempotencyKey: string;
}): Promise<McpBloodPressureResult> {
  const unstableKey = checkMcpIdempotencyKey(
    "log_blood_pressure",
    input.idempotencyKey,
  );
  if (unstableKey) return unstableKey;

  // Same validation the confirm-gate preview runs (both ranges, the systolic >
  // diastolic guard, and the measuredAt instant bound) — one verdict for both.
  const check = checkMcpBloodPressure(
    input.systolic,
    input.diastolic,
    input.measuredAt,
  );
  if (!check.ok) {
    annotate({
      action: { name: "mcp.tool.write" },
      meta: { tool: "log_blood_pressure", status: "out_of_range" },
    });
    return {
      status: "out_of_range",
      reason: check.reason ?? "Value out of range",
    };
  }

  const unit = "mmHg";
  const measuredAt = input.measuredAt ?? new Date();
  // ONE externalId for both rows — the shared idempotency namespace.
  const externalId = mcpExternalId("bp", input.idempotencyKey);

  const record: McpBloodPressureRecord = {
    systolic: input.systolic,
    diastolic: input.diastolic,
    unit,
    measuredAt: measuredAt.toISOString(),
    source: MCP_SOURCE,
  };

  const [existingSys, existingDia] = await Promise.all([
    prisma.measurement.findUnique({
      where: {
        userId_type_source_externalId: {
          userId: input.userId,
          type: "BLOOD_PRESSURE_SYS",
          source: MCP_SOURCE,
          externalId,
        },
      },
      select: { value: true, measuredAt: true },
    }),
    prisma.measurement.findUnique({
      where: {
        userId_type_source_externalId: {
          userId: input.userId,
          type: "BLOOD_PRESSURE_DIA",
          source: MCP_SOURCE,
          externalId,
        },
      },
      select: { value: true },
    }),
  ]);
  if (existingSys && existingDia) {
    annotate({
      action: { name: "mcp.tool.write" },
      meta: { tool: "log_blood_pressure", status: "already_logged" },
    });
    return {
      status: "already_logged",
      bloodPressure: {
        systolic: existingSys.value,
        diastolic: existingDia.value,
        unit,
        measuredAt: existingSys.measuredAt.toISOString(),
        source: MCP_SOURCE,
      },
    };
  }

  // Both rows in one transaction so a partial BP pair can never persist. No
  // mass assignment — every column is set explicitly from validated input.
  const created = await prisma.$transaction([
    prisma.measurement.create({
      data: {
        userId: input.userId,
        type: "BLOOD_PRESSURE_SYS",
        value: input.systolic,
        unit,
        source: MCP_SOURCE,
        measuredAt,
        externalId,
      },
      select: { id: true, type: true, measuredAt: true },
    }),
    prisma.measurement.create({
      data: {
        userId: input.userId,
        type: "BLOOD_PRESSURE_DIA",
        value: input.diastolic,
        unit,
        source: MCP_SOURCE,
        measuredAt,
        externalId,
      },
      select: { id: true, type: true, measuredAt: true },
    }),
  ]);

  void emitInsertedMeasurementArrivals(input.userId, created, "mcp").catch(
    () => {},
  );

  invalidateUserMeasurements(input.userId, { evict: true });

  // Best-effort rollup refresh for both series — a cache tier, never a
  // write-path invariant.
  try {
    await Promise.all([
      recomputeBucketsForMeasurement(
        input.userId,
        "BLOOD_PRESSURE_SYS",
        measuredAt,
      ),
      recomputeBucketsForMeasurement(
        input.userId,
        "BLOOD_PRESSURE_DIA",
        measuredAt,
      ),
    ]);
  } catch (rollupErr) {
    getEvent()?.addMeta(
      "mcp_blood_pressure_rollup_failed",
      rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
    );
  }

  await auditLog("mcp.write.blood_pressure", {
    userId: input.userId,
    details: {
      source: MCP_SOURCE,
      idempotencyKey: input.idempotencyKey,
    },
  });
  annotate({
    action: { name: "mcp.tool.write" },
    meta: { tool: "log_blood_pressure", status: "written" },
  });

  return { status: "written", bloodPressure: record };
}

/** Normalized mood record echoed back to the assistant. */
export interface McpMoodRecord {
  score: number;
  mood: string;
  note: string | null;
  date: string;
  source: typeof MCP_SOURCE;
}

export type McpMoodResult =
  | { status: "invalid_score" }
  | { status: "unstable_idempotency_key"; reason: string }
  | { status: "written"; moodEntry: McpMoodRecord }
  | { status: "already_logged"; moodEntry: McpMoodRecord };

/**
 * Log one mood entry on behalf of the resolved MCP session.
 *
 * Mirrors `logTelegramMood`: maps the 1..5 score to the canonical mood enum,
 * anchors the date key in the user's timezone, and is idempotent on the
 * NULL-distinct `(userId, source, externalId)` unique with `source = "MCP"`.
 */
export async function logMcpMood(input: {
  userId: string;
  score: number;
  note?: string | null;
  tz?: string | null;
  idempotencyKey: string;
}): Promise<McpMoodResult> {
  const unstableKey = checkMcpIdempotencyKey("log_mood", input.idempotencyKey);
  if (unstableKey) return unstableKey;

  const mood = MOOD_ENUM_BY_SCORE[input.score];
  if (!mood) {
    annotate({
      action: { name: "mcp.tool.write" },
      meta: { tool: "log_mood", status: "invalid_score" },
    });
    return { status: "invalid_score" };
  }

  const score = getScoreForMood(mood);
  const note = input.note ? input.note.slice(0, 500) : null;
  const moodLoggedAt = new Date();
  const tz = input.tz ?? DEFAULT_TIMEZONE;
  const date = moodDateKey(moodLoggedAt, tz);
  const externalId = mcpExternalId("mood", input.idempotencyKey);

  const existing = await prisma.moodEntry.findUnique({
    where: {
      userId_source_externalId: {
        userId: input.userId,
        source: MCP_SOURCE,
        externalId,
      },
    },
    select: {
      mood: true,
      score: true,
      note: true,
      noteEncrypted: true,
      date: true,
    },
  });
  if (existing) {
    annotate({
      action: { name: "mcp.tool.write" },
      meta: { tool: "log_mood", status: "already_logged" },
    });
    return {
      status: "already_logged",
      moodEntry: {
        score: existing.score,
        mood: existing.mood,
        note: readNote(existing.noteEncrypted, existing.note),
        date: existing.date,
        source: MCP_SOURCE,
      },
    };
  }

  // No mass assignment — every column is set explicitly from validated input.
  // v1.23 — encrypt the note at rest; legacy plaintext column nulled.
  const entry = await prisma.moodEntry.create({
    data: {
      userId: input.userId,
      date,
      tz,
      mood,
      score,
      // v1.37 — pleasantness derived from the same label the score comes
      // from. The tool still takes a 1-5 score; that is its input and it is
      // unchanged.
      moodA1: deriveA1(mood),
      note: null,
      noteEncrypted: encryptNote(note),
      source: MCP_SOURCE,
      externalId,
      moodLoggedAt,
    },
    select: {
      date: true,
      mood: true,
      note: true,
      noteEncrypted: true,
      tags: true,
    },
  });

  const savedNote = readNote(entry.noteEncrypted, entry.note);

  invalidateUserMood(input.userId);

  // Best-effort rollup refresh — a cache tier, never a write-path invariant.
  try {
    await recomputeMoodBucketsForEntry(input.userId, date);
  } catch (rollupErr) {
    getEvent()?.addMeta(
      "mcp_mood_rollup_failed",
      rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
    );
  }

  await auditLog("mcp.write.mood", {
    userId: input.userId,
    details: { source: MCP_SOURCE, idempotencyKey: input.idempotencyKey },
  });
  annotate({
    action: { name: "mcp.tool.write" },
    meta: { tool: "log_mood", status: "written" },
  });

  return {
    status: "written",
    moodEntry: {
      score,
      mood: entry.mood,
      note: savedNote,
      date: entry.date,
      source: MCP_SOURCE,
    },
  };
}
