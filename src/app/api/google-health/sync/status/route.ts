import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import {
  readGoogleHealthSyncProgress,
  type GoogleHealthResourceOutcome,
} from "@/lib/google-health/sync-progress";
import { annotate } from "@/lib/logging/context";
import type { NextRequest } from "next/server";

function count(value: unknown, maximum = 2_147_483_647): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(0, Math.trunc(value)))
    : 0;
}

function resource(value: unknown): GoogleHealthResourceOutcome {
  const item =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const statuses = [
    "pending",
    "complete",
    "partial",
    "empty",
    "truncated",
    "failed",
  ];
  const reasons = [
    "collection_failed",
    "token_failed",
    "upsert_failed",
    "rollup_failed",
    "existing_page_limit",
  ];
  return {
    resource:
      typeof item.resource === "string"
        ? item.resource
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .slice(0, 48)
        : "unknown",
    pages: count(item.pages),
    fetched: count(item.fetched),
    mapped: count(item.mapped),
    written: count(item.written),
    status: statuses.includes(String(item.status))
      ? (item.status as GoogleHealthResourceOutcome["status"])
      : "failed",
    durationMs: count(item.durationMs, 86_400_000),
    truncated: item.truncated === true,
    reasonCode: reasons.includes(String(item.reasonCode))
      ? (item.reasonCode as GoogleHealthResourceOutcome["reasonCode"])
      : null,
  };
}

function publicProgress(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const states = [
    "in_progress",
    "complete",
    "partial",
    "zero",
    "truncated",
    "failed",
    "interrupted",
  ];
  return {
    runId: typeof item.runId === "string" ? item.runId.slice(0, 128) : "",
    state: states.includes(String(item.state)) ? item.state : "failed",
    startedAt: typeof item.startedAt === "string" ? item.startedAt : "",
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
    ...(typeof item.terminalAt === "string"
      ? { terminalAt: item.terminalAt }
      : {}),
    imported: count(item.imported),
    failed: item.failed === true,
    resources: Array.isArray(item.resources)
      ? item.resources.slice(0, 16).map(resource)
      : [],
  };
}

/**
 * Return only the authenticated user's bounded current/most-recent run.
 * Query parameters are intentionally ignored so this endpoint cannot enumerate
 * another connection's progress.
 */
export const GET = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "google_health.sync.status" } });
  return apiSuccess(
    publicProgress(await readGoogleHealthSyncProgress(user.id)),
  );
});
