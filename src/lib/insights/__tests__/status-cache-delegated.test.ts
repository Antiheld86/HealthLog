/**
 * v1.37.0 — C5 at the choke point: a delegated read enqueues no generation.
 *
 * The MANAGE level opens the ten generated reads. Nine of them reach the
 * provider through `resolveReadOnlyStatusMiss`, one hop behind a GET that
 * looks like a cache read, so a manager's first visit to a metric page used to
 * ship the owner's health data to the owner's provider on the owner's budget
 * under the owner's consent receipt — with nothing in the response saying so.
 *
 * The suppression is implemented once, here, rather than in the ten generators
 * that call this function, so this file is where it has to be pinned. Both
 * directions, because either one alone is worthless: without the positive
 * control a broken function that never enqueues anything passes, and without
 * the negative one the condition is not tested at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueStatusGeneration = vi.fn(async () => {});
const probeProviderPresence = vi.fn(async () => true);
const aiCapabilityForRecord = vi.fn(async () => ({
  available: true,
  reason: null,
  onDeviceAllowed: true,
}));
const suppressed = vi.fn(() => false);

vi.mock("@/lib/jobs/insight-status-generate-shared", () => ({
  enqueueStatusGeneration: (...args: unknown[]) =>
    enqueueStatusGeneration(...(args as [])),
  STATUS_GENERATE_QUEUE: "insight-status-generate",
}));

vi.mock("@/lib/ai/provider", () => ({
  probeProviderPresence: (...args: unknown[]) =>
    probeProviderPresence(...(args as [])),
}));

vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord: (...args: unknown[]) =>
    aiCapabilityForRecord(...(args as [])),
}));

vi.mock("@/lib/sharing/delegated-generation", () => ({
  delegatedGenerationSuppressed: () => suppressed(),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    // The last-good text and the negative-cache probe both read the one
    // status-note row; no row is the cold-cache case this function is for.
    insightStatusCache: {
      findUnique: vi.fn(async () => null),
    },
  },
}));

import { resolveReadOnlyStatusMiss } from "@/lib/insights/status-cache";

beforeEach(() => {
  // Every counter, not only the enqueue: the ordering assertion below reads
  // the provider probe's call count, and a counter carried over from the
  // previous test would make it fail for the wrong reason (or pass for one).
  enqueueStatusGeneration.mockClear();
  probeProviderPresence.mockClear();
  aiCapabilityForRecord.mockClear();
  suppressed.mockReturnValue(false);
});

const ARGS = {
  userId: "owner-1",
  metric: "WEIGHT" as never,
  locale: "en" as never,
};

describe("resolveReadOnlyStatusMiss — the delegated path", () => {
  it("enqueues a generation for the person whose record it is", async () => {
    // The positive control. If this stops holding, the assertion below stops
    // meaning anything: "nothing was enqueued" would be true of a function
    // that never enqueues.
    const outcome = await resolveReadOnlyStatusMiss(ARGS);

    expect(enqueueStatusGeneration).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("preparing");
  });

  it("enqueues nothing while somebody else is holding the request", async () => {
    suppressed.mockReturnValue(true);

    const outcome = await resolveReadOnlyStatusMiss(ARGS);

    expect(enqueueStatusGeneration).not.toHaveBeenCalled();
    // Still served, not refused: the read is admitted at MANAGE and only the
    // generation behind it is withheld.
    expect(outcome.kind).toBe("preparing");
    if (outcome.kind === "preparing") {
      expect(outcome.revalidating).toBe(false);
    }
  });

  it("decides before it asks whether a provider exists", async () => {
    // Ordering matters for the money question, not only for the enqueue: the
    // provider probe reads the owner's configuration, and a suppressed
    // request has no business touching it.
    suppressed.mockReturnValue(true);

    await resolveReadOnlyStatusMiss(ARGS);

    // The capability is the one read allowed ahead of the decision; the
    // provider-presence probe belongs to the unavailable branch only.
    expect(aiCapabilityForRecord).toHaveBeenCalledWith("owner-1", "statusText");
    expect(probeProviderPresence).not.toHaveBeenCalled();
  });
});
