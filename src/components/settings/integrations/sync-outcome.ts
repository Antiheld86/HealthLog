"use client";

import { useTranslations } from "@/lib/i18n/context";
import type { WrittenOutcome } from "@/lib/outcome/written-outcome";

/**
 * What every provider-sync route answers with, and how a card says it.
 *
 * The cards used to key their tone off `res.ok`: the request came back, so the
 * line went green and printed a count. A run that imported nothing because
 * every reading was refused looked exactly like a clean one. The route now
 * resolves the outcome from what was written, and the card only renders it.
 */
export interface SyncOutcomeResponse {
  /** Rows that reached the database this run. */
  imported: number;
  /** True when any part of the run did not land. */
  failed: boolean;
  /** The resolved verdict — the card never recomputes this. */
  outcome: WrittenOutcome;
  /** Optional bounded per-resource evidence for providers that expose it. */
  resources?: SyncOutcomeResource[];
}

export interface SyncOutcomeResource {
  resource: string;
  written: number;
  status: "pending" | "complete" | "partial" | "empty" | "truncated" | "failed";
  reasonCode: string | null;
}

const RESOURCE_STATUSES = new Set<SyncOutcomeResource["status"]>([
  "pending",
  "complete",
  "partial",
  "empty",
  "truncated",
  "failed",
]);

export function readSyncOutcomeResource(
  value: unknown,
): SyncOutcomeResource | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.resource !== "string" ||
    !RESOURCE_STATUSES.has(record.status as SyncOutcomeResource["status"])
  ) {
    return null;
  }
  const resource = record.resource
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48);
  if (!resource) return null;
  return {
    resource,
    written:
      typeof record.written === "number" && Number.isFinite(record.written)
        ? Math.max(0, Math.min(2_147_483_647, Math.trunc(record.written)))
        : 0,
    status: record.status as SyncOutcomeResource["status"],
    reasonCode:
      typeof record.reasonCode === "string" &&
      /^[a-z0-9_-]{1,48}$/.test(record.reasonCode)
        ? record.reasonCode
        : null,
  };
}

/** What a card holds after a sync attempt, transport failures included. */
export interface SyncOutcomeState {
  outcome: WrittenOutcome;
  message: string;
}

/**
 * Narrow an envelope body to the resolved outcome, or `null` when the route
 * answered something else. A card that gets `null` treats the run as failed
 * rather than guessing — an unreadable answer is not evidence of a write.
 */
export function readSyncOutcome(body: unknown): SyncOutcomeResponse | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const { imported, failed, outcome } = data as Record<string, unknown>;
  if (typeof imported !== "number") return null;
  if (typeof failed !== "boolean") return null;
  if (
    outcome !== "empty" &&
    outcome !== "failed" &&
    outcome !== "partial" &&
    outcome !== "success"
  ) {
    return null;
  }
  const rawResources = (data as Record<string, unknown>).resources;
  const resources = Array.isArray(rawResources)
    ? rawResources
        .slice(0, 16)
        .map(readSyncOutcomeResource)
        .filter(
          (resource): resource is SyncOutcomeResource => resource !== null,
        )
    : undefined;
  return { imported, failed, outcome, ...(resources ? { resources } : {}) };
}

/**
 * Turn a resolved outcome into the sentence a card shows.
 *
 * The success wording stays per-provider (it names the provider's own count),
 * so the caller passes it in; everything else is shared, because "some of it
 * did not save" reads the same whoever the provider is. Written as literal
 * `t(...)` calls so the i18n call-site coverage guard sees every key.
 */
export function useSyncOutcomeMessage(): (
  result: SyncOutcomeResponse,
  successMessage: string,
) => string {
  const { t } = useTranslations();
  return (result, successMessage) => {
    switch (result.outcome) {
      case "success":
        return successMessage;
      case "empty":
        return t("settings.syncOutcome.empty");
      case "partial":
        return t("settings.syncOutcome.partial", { count: result.imported });
      case "failed":
        return t("settings.syncOutcome.failed");
    }
  };
}
