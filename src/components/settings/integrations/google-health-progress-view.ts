import type { SyncOutcomeResource } from "./sync-outcome";
import { readSyncOutcomeResource } from "./sync-outcome";

export type GoogleHealthProgressState =
  | "in_progress"
  | "complete"
  | "partial"
  | "zero"
  | "truncated"
  | "failed"
  | "interrupted";

export type GoogleHealthReasonCode =
  | "collection_failed"
  | "token_failed"
  | "upsert_failed"
  | "rollup_failed"
  | "existing_page_limit";

export interface GoogleHealthProgress {
  state: GoogleHealthProgressState;
  imported: number;
  resources: SyncOutcomeResource[];
}

const PROGRESS_STATES = new Set<GoogleHealthProgressState>([
  "in_progress",
  "complete",
  "partial",
  "zero",
  "truncated",
  "failed",
  "interrupted",
]);

const GOOGLE_REASON_CODES = new Set<GoogleHealthReasonCode>([
  "collection_failed",
  "token_failed",
  "upsert_failed",
  "rollup_failed",
  "existing_page_limit",
]);

export function readGoogleHealthProgress(
  body: unknown,
): GoogleHealthProgress | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (!PROGRESS_STATES.has(record.state as GoogleHealthProgressState)) {
    return null;
  }

  return {
    state: record.state as GoogleHealthProgressState,
    imported:
      typeof record.imported === "number" && Number.isFinite(record.imported)
        ? Math.max(0, Math.trunc(record.imported))
        : 0,
    resources: Array.isArray(record.resources)
      ? record.resources
          .slice(0, 16)
          .map(readSyncOutcomeResource)
          .filter(
            (resource): resource is SyncOutcomeResource => resource !== null,
          )
      : [],
  };
}

export function googleHealthReasonCode(
  resource: SyncOutcomeResource,
): GoogleHealthReasonCode | null {
  return GOOGLE_REASON_CODES.has(resource.reasonCode as GoogleHealthReasonCode)
    ? (resource.reasonCode as GoogleHealthReasonCode)
    : null;
}

export function failedGoogleHealthResources(
  progress: GoogleHealthProgress | null,
): SyncOutcomeResource[] {
  if (!progress) return [];
  return progress.resources
    .filter(
      (resource) =>
        resource.status === "failed" ||
        resource.status === "partial" ||
        resource.status === "truncated",
    )
    .slice(0, 5);
}

export function completedGoogleHealthResourceCount(
  progress: GoogleHealthProgress | null,
): number {
  if (!progress) return 0;
  return progress.resources.filter(
    (resource) =>
      resource.status === "complete" ||
      resource.status === "empty" ||
      resource.status === "partial" ||
      resource.status === "truncated",
  ).length;
}
