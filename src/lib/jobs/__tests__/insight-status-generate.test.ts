/**
 * v1.8.3 — unit tests for the on-demand per-metric status generation queue.
 *
 * Covers:
 *   - the dispatch runs the matching generator with force:true;
 *   - an unknown metric is annotated and skipped, not thrown;
 *   - the enqueue helper no-ops without a global boss instance and de-dupes
 *     with a singletonKey when one is present;
 *   - the queue is registered in `allQueues` AND wired to a `createAndWork`
 *     handler in reminder-worker.ts (the v1.4.37 W10 unregistered-queue
 *     catch — a queue built but never registered silently never drains).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const getGlobalBoss = vi.fn();
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: (...a: unknown[]) => getGlobalBoss(...a),
}));
// The dispatch module imports the seven generators transitively; stub them
// so the test never reaches a live provider.
vi.mock("@/lib/insights/general-status", () => ({
  generateGeneralStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/blood-pressure-status", () => ({
  generateBloodPressureStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/weight-status", () => ({
  generateWeightStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/pulse-status", () => ({
  generatePulseStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/bmi-status", () => ({
  generateBmiStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/mood-status", () => ({
  generateMoodStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/medication-compliance-status", () => ({
  generateMedicationComplianceStatusForUser: vi.fn(),
}));

import {
  runInsightStatusGenerate,
  enqueueStatusGeneration,
  INSIGHT_STATUS_GENERATE_QUEUE,
  INSIGHT_STATUS_METRICS,
} from "../insight-status-generate";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runInsightStatusGenerate", () => {
  it("forces the matching generator with the payload locale", async () => {
    const weight = vi.fn().mockResolvedValue(undefined);
    const generators = {
      general: vi.fn(),
      "blood-pressure": vi.fn(),
      weight,
      pulse: vi.fn(),
      bmi: vi.fn(),
      mood: vi.fn(),
      "medication-compliance": vi.fn(),
    };
    await runInsightStatusGenerate(
      {
        userId: "u1",
        metric: "weight",
        locale: "en",
        authority: {
          origin: "owner",
          recordUserId: "u1",
          actorUserId: "u1",
          grantId: null,
        },
      },
      generators,
    );
    expect(weight).toHaveBeenCalledWith("u1", { locale: "en", force: true });
    // No other generator ran.
    expect(generators.pulse).not.toHaveBeenCalled();
  });

  it("skips (does not throw) an unknown metric", async () => {
    await expect(
      runInsightStatusGenerate(
        {
          userId: "u1",
          metric: "nope" as never,
          locale: "de",
          authority: {
            origin: "owner",
            recordUserId: "u1",
            actorUserId: "u1",
            grantId: null,
          },
        },
        {} as never,
      ),
    ).resolves.toBeUndefined();
  });

  it("exposes the seven canonical metrics", () => {
    expect([...INSIGHT_STATUS_METRICS].sort()).toEqual(
      [
        "general",
        "blood-pressure",
        "weight",
        "pulse",
        "bmi",
        "mood",
        "medication-compliance",
      ].sort(),
    );
  });
});

describe("enqueueStatusGeneration", () => {
  it("no-ops when no global boss is available", async () => {
    getGlobalBoss.mockReturnValue(null);
    await expect(
      enqueueStatusGeneration({ userId: "u1", metric: "weight", locale: "de" }),
    ).resolves.toBeUndefined();
  });

  it("sends with a per-(user,metric) singletonKey when boss exists", async () => {
    const send = vi.fn().mockResolvedValue("job-id");
    getGlobalBoss.mockReturnValue({ send });
    await enqueueStatusGeneration({
      userId: "u1",
      metric: "mood",
      locale: "en",
    });
    expect(send).toHaveBeenCalledWith(
      INSIGHT_STATUS_GENERATE_QUEUE,
      {
        userId: "u1",
        metric: "mood",
        locale: "en",
        authority: {
          origin: "system",
          recordUserId: "u1",
          actorUserId: null,
          grantId: null,
        },
      },
      expect.objectContaining({ singletonKey: "u1:mood" }),
    );
  });

  /**
   * Cost guard. The locale on a status read is client-chosen (`?locale=`, or
   * the `healthlog-locale` cookie), so when it was part of the singleton key
   * each of the six supported locales opened its own de-dupe slot and one
   * legitimate generation pass could be multiplied into six. The key must
   * collapse them: same user, same metric, one queued generation regardless of
   * how many locales ask.
   */
  it("collapses every locale for one metric onto a single singletonKey", async () => {
    const send = vi.fn().mockResolvedValue("job-id");
    getGlobalBoss.mockReturnValue({ send });

    for (const locale of ["de", "en", "fr", "es", "it", "pl", "ko"] as const) {
      await enqueueStatusGeneration({ userId: "u1", metric: "mood", locale });
    }

    const keys = new Set(
      send.mock.calls.map(
        (call) => (call[2] as { singletonKey: string }).singletonKey,
      ),
    );
    expect(keys).toEqual(new Set(["u1:mood"]));
  });

  it("swallows a boss.send rejection (best-effort enqueue)", async () => {
    const send = vi.fn().mockRejectedValue(new Error("boom"));
    getGlobalBoss.mockReturnValue({ send });
    await expect(
      enqueueStatusGeneration({ userId: "u1", metric: "bmi", locale: "de" }),
    ).resolves.toBeUndefined();
  });
});

describe("queue registration", () => {
  // v1.18.1 — the insight-status-generate wiring moved out of the 2143-LOC
  // reminder-worker boot file into the status registrar. The dead-queue guard
  // follows the wiring there.
  const workerSrc = fs.readFileSync(
    path.resolve(__dirname, "../reminder/register-status.ts"),
    "utf8",
  );

  it("registers the queue name in the allQueues createQueue loop", () => {
    const match = workerSrc.match(/const allQueues\s*=\s*\[([\s\S]*?)\];/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/\bINSIGHT_STATUS_GENERATE_QUEUE\b/);
  });

  it("registers a createAndWork handler for the queue", () => {
    expect(workerSrc).toMatch(
      /createAndWork[\s\S]{0,120}INSIGHT_STATUS_GENERATE_QUEUE/,
    );
  });

  it("exposes a stable queue name", () => {
    expect(INSIGHT_STATUS_GENERATE_QUEUE).toBe("insight-status-generate");
  });
});
