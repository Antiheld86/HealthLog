/**
 * §5 — the poll-cohort factory boundary. A provider that records-then-rethrows
 * marks its error so the boundary does NOT record it a second time (which would
 * inflate the per-kind buckets and, for Nightscout, risk re-persisting a
 * token-bearing URL). An UNMARKED escape — today's Oura / Polar write-path throw
 * — is recorded exactly once through the per-provider `recordFailure` callback.
 * A recorder rejection never breaks the cohort loop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";

const warnings: string[] = [];

vi.mock("@/lib/jobs/worker-status", () => ({ recordError: vi.fn() }));
vi.mock("@/lib/jobs/reminder-satisfy", () => ({
  enqueueReminderSatisfy: vi.fn(async () => undefined),
}));
vi.mock("@/lib/logging/fire-and-forget", () => ({ fireAndForget: vi.fn() }));
vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: async (
    _name: string,
    fn: (evt: {
      setBackground: () => void;
      setError: () => void;
      addWarning: (w: string) => void;
    }) => Promise<void>,
  ) =>
    fn({
      setBackground: vi.fn(),
      setError: vi.fn(),
      addWarning: (w: string) => warnings.push(w),
    }),
}));
vi.mock("../shared", () => ({
  getWorkerPrisma: () => ({}),
}));

import { makePollCohortHandler } from "../poll-cohort";
import { markSyncFailureRecorded } from "@/lib/integrations/status";

function job(userId?: string): Job<{ userId?: string }> {
  return { data: userId ? { userId } : {} } as Job<{ userId?: string }>;
}

beforeEach(() => {
  warnings.length = 0;
  vi.clearAllMocks();
});

describe("makePollCohortHandler — marker-aware recordFailure boundary", () => {
  it("records an UNMARKED escape once, then warns, and continues the cohort", async () => {
    const recordFailure = vi.fn(async () => {});
    const syncUser = vi.fn(async (userId: string) => {
      if (userId === "boom") throw new Error("unmarked write failure");
      return 1;
    });
    const handler = makePollCohortHandler({
      taskName: "job.test_sync",
      findCohort: async () => ["a", "boom", "b"],
      syncUser,
      recordFailure,
    });

    await handler([job()]);

    // The failing user is recorded once and warned; the other two still sync.
    expect(syncUser).toHaveBeenCalledTimes(3);
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith(
      "boom",
      expect.objectContaining({ message: "unmarked write failure" }),
    );
    expect(warnings.some((w) => w.includes("boom"))).toBe(true);
  });

  it("does NOT record a MARKED error (the source already recorded it)", async () => {
    const recordFailure = vi.fn(async () => {});
    const syncUser = vi.fn(async () => {
      throw markSyncFailureRecorded(new Error("already recorded at source"));
    });
    const handler = makePollCohortHandler({
      taskName: "job.test_sync",
      findCohort: async () => ["a"],
      syncUser,
      recordFailure,
    });

    await handler([job()]);

    expect(recordFailure).not.toHaveBeenCalled();
    // Still warned so the cohort event carries the failure.
    expect(warnings.some((w) => w.includes("already recorded"))).toBe(true);
  });

  it("a recorder rejection never breaks the cohort loop", async () => {
    const recordFailure = vi.fn(async () => {
      throw new Error("recorder down");
    });
    const syncUser = vi.fn(async (userId: string) => {
      if (userId === "boom") throw new Error("unmarked");
      return 1;
    });
    const handler = makePollCohortHandler({
      taskName: "job.test_sync",
      findCohort: async () => ["boom", "next"],
      syncUser,
      recordFailure,
    });

    // The recorder rejection is warned, not propagated: the pass ran, so the
    // job is done and the failing user is a `users_failed` count.
    await expect(handler([job()])).resolves.toEqual({
      ok: true,
      did: {
        total: 2,
        users_synced: 1,
        users_failed: 1,
        measurements_imported: 1,
      },
    });
    // The next user still synced despite the recorder throwing.
    expect(syncUser).toHaveBeenCalledTimes(2);
    expect(syncUser).toHaveBeenLastCalledWith("next");
  });
});
