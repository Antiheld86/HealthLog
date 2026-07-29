import { randomBytes } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export const GOOGLE_HEALTH_PROGRESS_STALE_MS = 30 * 60 * 1000;
export const GOOGLE_HEALTH_PROGRESS_MAX_RESOURCES = 16;

const MAX_COUNTER = 2_147_483_647;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const progressWriteTails = new Map<string, Promise<void>>();

const RUN_STATES = new Set([
  "in_progress",
  "complete",
  "partial",
  "zero",
  "truncated",
  "failed",
  "interrupted",
] as const);
const RESOURCE_STATES = new Set([
  "pending",
  "complete",
  "partial",
  "empty",
  "truncated",
  "failed",
] as const);
const REASON_CODES = new Set([
  "collection_failed",
  "token_failed",
  "upsert_failed",
  "rollup_failed",
  "existing_page_limit",
] as const);

export type GoogleHealthSyncState =
  | "in_progress"
  | "complete"
  | "partial"
  | "zero"
  | "truncated"
  | "failed"
  | "interrupted";

export type GoogleHealthResourceStatus =
  "pending" | "complete" | "partial" | "empty" | "truncated" | "failed";

export type GoogleHealthReasonCode =
  | "collection_failed"
  | "token_failed"
  | "upsert_failed"
  | "rollup_failed"
  | "existing_page_limit";

export interface GoogleHealthResourceOutcome {
  resource: string;
  pages: number;
  fetched: number;
  mapped: number;
  written: number;
  status: GoogleHealthResourceStatus;
  durationMs: number;
  truncated: boolean;
  reasonCode: GoogleHealthReasonCode | null;
}

export interface GoogleHealthSyncProgress {
  runId: string;
  state: GoogleHealthSyncState;
  startedAt: string;
  updatedAt: string;
  terminalAt?: string;
  imported: number;
  failed: boolean;
  resources: GoogleHealthResourceOutcome[];
}

const INITIAL_RESOURCES = [
  "workout",
  "sleep",
  "bounded-metrics",
  "activity",
  "dense-heart-rate",
] as const;

function boundedInteger(value: unknown, maximum = MAX_COUNTER): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, Math.trunc(value)));
}

function sanitizedResourceName(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return normalized.replace(/-+/g, "-").slice(0, 48) || "unknown";
}

function resourceOutcome(
  value: unknown,
  fallbackResource = "unknown",
): GoogleHealthResourceOutcome {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const status = RESOURCE_STATES.has(
    record.status as GoogleHealthResourceStatus,
  )
    ? (record.status as GoogleHealthResourceStatus)
    : "pending";
  const reasonCode = REASON_CODES.has(
    record.reasonCode as GoogleHealthReasonCode,
  )
    ? (record.reasonCode as GoogleHealthReasonCode)
    : null;
  return {
    resource: sanitizedResourceName(record.resource ?? fallbackResource),
    pages: boundedInteger(record.pages),
    fetched: boundedInteger(record.fetched),
    mapped: boundedInteger(record.mapped),
    written: boundedInteger(record.written),
    status,
    durationMs: boundedInteger(record.durationMs, MAX_DURATION_MS),
    truncated: record.truncated === true,
    reasonCode,
  };
}

function initialResources(): GoogleHealthResourceOutcome[] {
  return INITIAL_RESOURCES.map((resource) => resourceOutcome({}, resource));
}

function isoDate(value: unknown, fallback: Date): string {
  if (typeof value !== "string") return fallback.toISOString();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : fallback.toISOString();
}

function progressEnvelope(
  value: unknown,
  fallback: {
    runId: string;
    now: Date;
    startedAt?: string;
  },
): GoogleHealthSyncProgress {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const state = RUN_STATES.has(record.state as GoogleHealthSyncState)
    ? (record.state as GoogleHealthSyncState)
    : "in_progress";
  const resources = Array.isArray(record.resources)
    ? record.resources
        .slice(0, GOOGLE_HEALTH_PROGRESS_MAX_RESOURCES)
        .map((resource) => resourceOutcome(resource))
    : initialResources();
  const envelope: GoogleHealthSyncProgress = {
    runId: fallback.runId,
    state,
    startedAt: isoDate(record.startedAt ?? fallback.startedAt, fallback.now),
    updatedAt: fallback.now.toISOString(),
    imported: boundedInteger(record.imported ?? record.written),
    failed: record.failed === true,
    resources,
  };
  if (state !== "in_progress") {
    envelope.terminalAt = isoDate(record.terminalAt, fallback.now);
  }
  return envelope;
}

function asJson(value: GoogleHealthSyncProgress): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

async function serializeProgressWrite<T>(
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = progressWriteTails.get(userId) ?? Promise.resolve();
  let release = () => {};
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  progressWriteTails.set(userId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (progressWriteTails.get(userId) === tail) {
      progressWriteTails.delete(userId);
    }
  }
}

export async function startGoogleHealthSyncProgress(
  userId: string,
  now = new Date(),
): Promise<GoogleHealthSyncProgress> {
  const runId = randomBytes(18).toString("base64url");
  const envelope = progressEnvelope(
    {
      state: "in_progress",
      startedAt: now.toISOString(),
      imported: 0,
      failed: false,
      resources: initialResources(),
    },
    { runId, now },
  );
  await serializeProgressWrite(userId, () =>
    prisma.googleHealthConnection.update({
      where: { userId },
      data: { syncProgress: asJson(envelope) },
    }),
  );
  return envelope;
}

async function guardedProgressUpdate(
  userId: string,
  runId: string,
  envelope: GoogleHealthSyncProgress,
): Promise<boolean> {
  const result = await serializeProgressWrite(userId, () =>
    prisma.googleHealthConnection.updateMany({
      where: {
        userId,
        syncProgress: {
          path: ["runId"],
          equals: runId,
        },
      },
      data: { syncProgress: asJson(envelope) },
    }),
  );
  return result.count === 1;
}

export async function updateGoogleHealthSyncProgress(
  userId: string,
  runId: string,
  update: Record<string, unknown>,
  now = new Date(),
): Promise<boolean> {
  // Issue the guarded write without a preceding read. Besides avoiding a
  // read/modify/write window, this makes the database choose one winner when a
  // delayed terminal competes with a new run. Callers pass the complete
  // bounded envelope (including resources and startedAt) on each update.
  const merged = progressEnvelope(update, {
    runId,
    now,
    startedAt:
      typeof update.startedAt === "string" ? update.startedAt : undefined,
  });
  return guardedProgressUpdate(userId, runId, merged);
}

async function loadProgress(
  userId: string,
): Promise<GoogleHealthSyncProgress | null> {
  const connection = await prisma.googleHealthConnection.findUnique({
    where: { userId },
    select: { syncProgress: true },
  });
  const stored = connection?.syncProgress;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return null;
  }
  const runId =
    typeof (stored as Record<string, unknown>).runId === "string"
      ? String((stored as Record<string, unknown>).runId).slice(0, 128)
      : "";
  if (!runId) return null;
  const updatedAt = isoDate(
    (stored as Record<string, unknown>).updatedAt,
    new Date(0),
  );
  return progressEnvelope(stored, {
    runId,
    now: new Date(updatedAt),
  });
}

export async function readGoogleHealthSyncProgress(
  userId: string,
  now = new Date(),
): Promise<GoogleHealthSyncProgress | null> {
  const current = await loadProgress(userId);
  if (!current || current.state !== "in_progress") return current;
  const updatedAt = new Date(current.updatedAt).getTime();
  if (now.getTime() - updatedAt <= GOOGLE_HEALTH_PROGRESS_STALE_MS) {
    return current;
  }

  const interrupted = progressEnvelope(
    {
      ...current,
      state: "interrupted",
      failed: true,
      terminalAt: now.toISOString(),
    },
    { runId: current.runId, now, startedAt: current.startedAt },
  );
  if (await guardedProgressUpdate(userId, current.runId, interrupted)) {
    return interrupted;
  }
  return loadProgress(userId);
}
