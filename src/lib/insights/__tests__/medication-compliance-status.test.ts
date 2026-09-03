import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
  // Consent never blocks in these fixtures — the gate has its own tests.
  statusConsentBlocksGeneration: vi.fn(async () => false),
}));

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/medication-category", () => ({
  getMedicationCategories: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { getMedicationCategories } from "@/lib/medication-category";
import { getNoKeyMedicationComplianceStatusText } from "@/lib/insights/no-key-fallbacks";
import { generateMedicationComplianceStatusForUser } from "../medication-compliance-status";

const dayMs = 24 * 60 * 60 * 1000;

function stubCompletion(
  content: string,
  capture?: { userPrompt: string | null },
) {
  vi.mocked(runStatusCompletion).mockImplementation(
    async (args: { userPrompt: string }) => {
      if (capture) capture.userPrompt = args.userPrompt;
      return {
        kind: "ok",
        content,
        providerType: "anthropic",
        model: "x",
        tokensUsed: 1,
      } as never;
    },
  );
}

function medFixture(now: Date) {
  return {
    id: "med-1",
    name: "Ramipril",
    dose: "5mg",
    active: true,
    createdAt: new Date(now.getTime() - 60 * dayMs),
    schedules: [
      { id: "s1", windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
    ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getMedicationCategories).mockResolvedValue({});
});

describe("generateMedicationComplianceStatusForUser — graded payload", () => {
  it("emits a graded {recent, weekly, monthly} compliance series per medication", async () => {
    const now = new Date();
    const medication = {
      id: "med-1",
      name: "TestMed",
      dose: "5mg",
      active: true,
      createdAt: new Date(now.getTime() - 1100 * dayMs),
      schedules: [
        {
          id: "s1",
          windowStart: "08:00",
          windowEnd: "09:00",
          daysOfWeek: null,
        },
      ],
    };

    const events: Array<{
      medicationId: string;
      scheduledFor: Date;
      takenAt: Date | null;
      skipped: boolean;
    }> = [];
    for (let day = 0; day < 1000; day++) {
      const scheduledFor = new Date(now.getTime() - day * dayMs);
      events.push({
        medicationId: "med-1",
        scheduledFor,
        takenAt: day % 3 === 0 ? null : scheduledFor,
        skipped: false,
      });
    }

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medication,
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      events as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK","medications":[]}', captured);

    await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    expect(snapshot.medications).toBeInstanceOf(Array);
    expect(snapshot.medications.length).toBe(1);
    const dailySeries = snapshot.medications[0].dailySeries;
    expect(dailySeries).toHaveProperty("recent");
    expect(dailySeries).toHaveProperty("weekly");
    expect(dailySeries).toHaveProperty("monthly");
    expect(dailySeries).toHaveProperty("yearly");
    expect(dailySeries.recent.length).toBeLessThanOrEqual(21);
    expect(dailySeries.recent[0]).toHaveProperty("date");
    expect(dailySeries.recent[0]).toHaveProperty("mean");
    expect(dailySeries.monthly[0]).toHaveProperty("month");
  });
});

describe("generateMedicationComplianceStatusForUser — timeout never persists", () => {
  it("serves the fallback summary without writing a cache row on timeout", async () => {
    const now = new Date();
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medFixture(now),
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "timeout",
    } as never);

    const result = await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.summary).toBeTruthy();
    expect(result.medications).toEqual([]);
    expect(result.cached).toBe(true);
    expect(result.updatedAt).toBeNull();
    // v1.8.3 — no real assessment persisted (updatedAt stays null above),
    // but a short-TTL negative stub IS written so the read-only route does
    // not re-enqueue on every navigation while the provider is degraded.
    // The stub is a timeout marker that `readFreshStatusText` rejects.
    await Promise.resolve();
    for (const call of vi.mocked(prisma.auditLog.create).mock.calls) {
      const details = JSON.parse(
        (call[0] as { data: { details: string } }).data.details,
      );
      expect(details.timeout === true || details.model === "timeout-stub").toBe(
        true,
      );
    }
  });
});

describe("generateMedicationComplianceStatusForUser — cache-read skips a stub", () => {
  it("regenerates when the only cached row is a timeout stub", async () => {
    const now = new Date();
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    }).format(now);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue({
      createdAt: now,
      details: JSON.stringify({
        dateKey: todayKey,
        locale: "en",
        text: "Medication compliance fallback…",
        model: "timeout-stub",
        timeout: true,
      }),
    } as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medFixture(now),
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);

    stubCompletion(
      '{"summary":"Fresh compliance assessment.","medications":[]}',
    );

    const result = await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe("Fresh compliance assessment.");
    expect(result.cached).toBe(false);
  });
});

describe("generateMedicationComplianceStatusForUser — outbound screen (v1.32.20)", () => {
  /**
   * The medication-adherence card is the highest-leverage surface for the
   * outbound screen — a dose-change imperative or a fabricated figure lands
   * exactly here. v1.32.20 routes it through `finalizeStatusSummary`, so it now
   * WITHHOLDS the same dose / risk / causal violations its seven sibling status
   * cards do (previously it only withheld unparseable envelopes). WITHHOLD =
   * serve the deterministic no-key line, persist no model text, `updatedAt`
   * stays null; the per-medication placeholder rows still render.
   */
  function setupCard(now: Date) {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medFixture(now),
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);
  }

  it("withholds a dose-change imperative instead of rendering the raw prose", async () => {
    const now = new Date();
    setupCard(now);
    stubCompletion('{"summary":"Increase your dose to 10 mg next week."}');

    const result = await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.summary).toBe(getNoKeyMedicationComplianceStatusText("en"));
    expect(result.summary).not.toContain("10 mg");
    expect(result.summary).not.toContain("Increase");
    expect(result.updatedAt).toBeNull();
    // The per-medication placeholder rows still surface for the active med.
    expect(result.medications).toHaveLength(1);
    // No cache row ever persisted the screened model text.
    for (const call of vi.mocked(prisma.auditLog.create).mock.calls) {
      const details = JSON.parse(
        (call[0] as { data: { details: string } }).data.details,
      ) as { summary?: string };
      expect(details.summary ?? "").not.toContain("10 mg");
    }
  });

  it("withholds a fabricated risk figure instead of rendering the raw prose", async () => {
    const now = new Date();
    setupCard(now);
    stubCompletion(
      '{"summary":"Your 10-year cardiovascular risk is about 14%."}',
    );

    const result = await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.summary).toBe(getNoKeyMedicationComplianceStatusText("en"));
    expect(result.summary).not.toContain("14%");
    expect(result.updatedAt).toBeNull();
    expect(result.medications).toHaveLength(1);
  });

  it("still renders a clean grounded compliance summary", async () => {
    const now = new Date();
    setupCard(now);
    stubCompletion(
      '{"summary":"Adherence held steady at 96% across the last 30 days."}',
    );

    const result = await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.summary).toBe(
      "Adherence held steady at 96% across the last 30 days.",
    );
    expect(result.updatedAt).not.toBeNull();
    expect(result.cached).toBe(false);
    // The clean assessment was persisted (not the negative stub).
    const persisted = vi
      .mocked(prisma.auditLog.create)
      .mock.calls.map(
        (call) =>
          JSON.parse(
            (call[0] as { data: { details: string } }).data.details,
          ) as { summary?: string },
      )
      .find((details) => (details.summary ?? "").includes("96%"));
    expect(persisted).toBeTruthy();
  });
});

describe("generateMedicationComplianceStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached summary", async () => {
    const now = new Date();

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medFixture(now),
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    // The compliance prompt returns only a `{ summary }` envelope; the
    // per-medication cards are placeholder text built server-side, never
    // model-authored. So token-leak hardening only has to scrub `summary`.
    stubCompletion(
      JSON.stringify({
        summary:
          "Compliance held steady at 96%. metric:BLOOD_PRESSURE_SYS over the last 30 days.",
      }),
    );

    const result = await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.summary).toBeTruthy();
    expect(result.summary).not.toContain("metric:");
    // A per-medication placeholder row is still surfaced for the active med.
    expect(result.medications).toHaveLength(1);
    expect(result.medications[0].medicationId).toBe("med-1");
    expect(result.medications[0].text).not.toContain("metric:");
    const createCalls = vi.mocked(prisma.auditLog.create).mock.calls;
    expect(createCalls.length).toBeGreaterThan(0);
    const details = (createCalls[0][0] as { data: { details: string } }).data
      .details;
    const parsed = JSON.parse(details) as {
      summary: string;
      medications: Array<{ text: string }>;
    };
    expect(parsed.summary).not.toContain("metric:");
    expect(parsed.medications[0].text).not.toContain("metric:");
  });
});

// A medication with no schedule expects no dose. `calculateCompliance` answers
// `rate: 100, totalExpected: 0` for that case, and this surface averaged that
// 100 into `overall.averageCompliance30` and handed it to the model as the
// person's adherence. The doctor report has excluded the empty schedule
// alongside PRN since it was written — "so the report never prints a
// fabricated 100 %" — and the same reason applies wherever a rate is shown.
describe("generateMedicationComplianceStatusForUser — no rate without an expectation", () => {
  function scheduleless(now: Date) {
    return {
      id: "med-empty",
      name: "Unscheduled",
      dose: "5mg",
      active: true,
      asNeeded: false,
      createdAt: new Date(now.getTime() - 60 * dayMs),
      schedules: [],
      scheduleRevisions: [],
      pauseEras: [],
    };
  }

  it("keeps a schedule-less medication out of the snapshot and its average", async () => {
    const now = new Date();
    const scheduled = { ...medFixture(now), asNeeded: false };
    const events = Array.from({ length: 30 }, (_, day) => {
      const scheduledFor = new Date(now.getTime() - day * dayMs);
      // Half the doses taken, so the real medication sits well below 100 %.
      return {
        medicationId: "med-1",
        scheduledFor,
        takenAt: day % 2 === 0 ? scheduledFor : null,
        skipped: false,
      };
    });

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      scheduled,
      scheduleless(now),
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      events as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK","medications":[]}', captured);

    await generateMedicationComplianceStatusForUser("user-1", { locale: "en" });

    const snapshot = JSON.parse(captured.userPrompt!.match(/\{[\s\S]*\}/)![0]);
    const names = snapshot.medications.map((m: { name: string }) => m.name);
    expect(names).not.toContain("Unscheduled");
    expect(names).toContain("Ramipril");
    expect(snapshot.overall.medicationCount).toBe(1);
    // The fabricated 100 is no longer half of the average handed to the model.
    expect(snapshot.overall.averageCompliance30).toBeLessThan(100);
  });

  it("reports no active medications when the only one has no schedule", async () => {
    const now = new Date();
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      scheduleless(now),
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );

    const outcome = (await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    })) as { summary: string | null; medications: unknown[] };

    expect(outcome.medications).toEqual([]);
    expect(outcome.summary).toContain("no active medications");
    // Nothing to assess, so no model call and no cache row either.
    expect(runStatusCompletion).not.toHaveBeenCalled();
  });
});
