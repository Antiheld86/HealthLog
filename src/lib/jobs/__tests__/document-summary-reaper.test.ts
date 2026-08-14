/**
 * The hourly stale-PENDING summary reaper (the persistence arm of the heal
 * `serialiseDocumentDetail` applies at read time).
 *
 * Watched red: with the TTL predicate dropped from the updateMany `where`
 * (healing EVERY pending row), the cutoff assertion fails — a summary job
 * legitimately in flight must never be claimed.
 */
import { describe, expect, it, vi } from "vitest";

import { SUMMARY_PENDING_TTL_MS } from "@/lib/documents/store";

import { reapStalePendingSummaries } from "../document-summary-reaper";

describe("reapStalePendingSummaries", () => {
  it("heals only PENDING rows older than the TTL, to UNAVAILABLE", async () => {
    const updateMany = vi.fn(async () => ({ count: 3 }));
    const prisma = { inboundDocument: { updateMany } } as never;
    const now = new Date("2026-08-14T12:00:00.000Z");

    const healed = await reapStalePendingSummaries(prisma, now);

    expect(healed).toBe(3);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        summaryState: "PENDING",
        updatedAt: { lt: new Date(now.getTime() - SUMMARY_PENDING_TTL_MS) },
      },
      data: { summaryState: "UNAVAILABLE" },
    });
  });
});
