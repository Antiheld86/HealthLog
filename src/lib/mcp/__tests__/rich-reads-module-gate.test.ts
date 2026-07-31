/**
 * v1.30.22 — the module gate on the rollup-backed rich reads.
 *
 * These three reads deliberately bypass `buildCoachSnapshot`, which is where
 * the module narrowing lives for every Coach-routed read. They therefore
 * inherited no gate at all: `get_metric_series` honestly reported
 * `{ present: false }` for a glucose-disabled account while
 * `get_metric_baseline` handed back the median, the MAD band and today's
 * placement for the same metric — on the one wire that egresses to a
 * third-party assistant.
 *
 * Both layers matter and both are asserted here. `isModuleEnabled` resolves
 * `operatorAvailable(key) && userEnabled(key)`, so a `false` from it is the
 * OPERATOR kill-switch just as much as the user toggle — the sharper case,
 * because a leak there defeats a server-wide decision the account holder
 * cannot override.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/ai/coach/tools/correlations-read", () => ({
  readCoachCorrelations: vi.fn(async () => ({ present: false })),
}));
vi.mock("@/lib/insights/derived/coach-read", () => ({
  buildCoachReadStrip: vi.fn(),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rollups/measurement-read-wmy")>();
  return { ...actual, readBestGranularityRollups: vi.fn() };
});
const { labResult, measurement, user } = vi.hoisted(() => ({
  labResult: { findMany: vi.fn() },
  measurement: { count: vi.fn(async () => 0), groupBy: vi.fn(async () => []) },
  // The rich reads resolve the account's language before asking for a
  // narrated sentence, which reads the stored preference.
  user: { findUnique: vi.fn(async () => ({ locale: "de" })) },
}));
vi.mock("@/lib/db", () => ({ prisma: { labResult, measurement, user } }));

import {
  compareMetric,
  getMetricBaseline,
  detectChangepoints,
  metricStatusDiscoveryRows,
  MCP_METRIC_STATUS_DISCOVERY,
} from "../rich-reads";
import { isModuleEnabled } from "@/lib/modules/gate";
import { buildCoachReadStrip } from "@/lib/insights/derived/coach-read";
import { readBestGranularityRollups } from "@/lib/rollups/measurement-read-wmy";
import type { ModuleKey } from "@/lib/modules/gate";

const USER = "u1";

/** A bucket sequence dense enough for every read to produce a real answer. */
function buckets(n = 60) {
  const start = Date.UTC(2026, 0, 1);
  return {
    granularity: "DAY" as const,
    rows: Array.from({ length: n }, (_, i) => ({
      bucketStart: new Date(start + i * 86_400_000),
      // A clean level shift halfway so `detect_changepoints` has something to
      // find — the read must be capable of a `present: true` answer, or a
      // `present: false` under the gate would prove nothing.
      sum: i < n / 2 ? 100 : 160,
      count: 1,
      min: i < n / 2 ? 100 : 160,
      max: i < n / 2 ? 100 : 160,
    })),
  };
}

/** Drive the gate: every module on except the named one. */
function disableModule(key: ModuleKey) {
  vi.mocked(isModuleEnabled).mockImplementation(
    async (_userId: string, moduleKey: ModuleKey) => moduleKey !== key,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isModuleEnabled).mockImplementation(async () => true);
  measurement.count.mockResolvedValue(0);
  measurement.groupBy.mockResolvedValue([]);
  vi.mocked(readBestGranularityRollups).mockResolvedValue(
    buckets() as unknown as Awaited<
      ReturnType<typeof readBestGranularityRollups>
    >,
  );
  vi.mocked(buildCoachReadStrip).mockResolvedValue({
    baseline: { median: 100, low: 90, high: 110 },
    learning: false,
    latest: { value: 105, at: new Date().toISOString() },
  } as unknown as Awaited<ReturnType<typeof buildCoachReadStrip>>);
});

describe("rich reads — per-domain module gate", () => {
  // `glucose` → BLOOD_GLUCOSE is the pairing the audit named explicitly: the
  // metric where the honest `get_metric_series` and the leaking
  // `get_metric_baseline` disagreed for the same account.
  describe.each([
    { metric: "glucose", module: "glucose" as ModuleKey },
    { metric: "sleep", module: "sleep" as ModuleKey },
    { metric: "hrv", module: "recovery" as ModuleKey },
    { metric: "sleep_score", module: "sleep" as ModuleKey },
    { metric: "day_strain", module: "workouts" as ModuleKey },
  ])("$metric (owned by $module)", ({ metric, module }) => {
    it("get_metric_baseline answers with the module ON", async () => {
      const on = await getMetricBaseline(USER, { metric });
      expect(on.present).toBe(true);
    });

    it("get_metric_baseline omits with the module OFF", async () => {
      disableModule(module);
      const off = await getMetricBaseline(USER, { metric });
      expect(off.present).toBe(false);
      expect(off.reason).toBe("module_disabled");
      // The gate must short-circuit BEFORE the engine runs — a read that
      // computes the band and then hides it has still loaded the data.
      expect(buildCoachReadStrip).not.toHaveBeenCalled();
    });

    it("compare_metric omits with the module OFF", async () => {
      disableModule(module);
      const off = await compareMetric(USER, {
        metric,
        window: "last30days",
        windowB: "last90days",
      });
      expect(off.present).toBe(false);
      expect(off.reason).toBe("module_disabled");
      expect(readBestGranularityRollups).not.toHaveBeenCalled();
    });

    it("detect_changepoints omits with the module OFF", async () => {
      disableModule(module);
      const off = await detectChangepoints(USER, { metric });
      expect(off.present).toBe(false);
      expect(off.reason).toBe("module_disabled");
      expect(readBestGranularityRollups).not.toHaveBeenCalled();
    });
  });

  it("refuses the whole comparison when only side B is gated", async () => {
    // A one-sided degrade would answer the question anyway using the ungated
    // side, so the gated side must sink the entire call.
    disableModule("glucose");
    const res = await compareMetric(USER, {
      metric: "weight",
      metricB: "glucose",
    });
    expect(res.present).toBe(false);
    expect(res.reason).toBe("module_disabled_b");
  });

  it("leaves a metric no module owns ungated", async () => {
    // Weight/pulse/BP are core clinical figures with no owning module; gating
    // them would hide data the user never opted out of. Turning every module
    // off must not touch them.
    vi.mocked(isModuleEnabled).mockImplementation(async () => false);
    const res = await getMetricBaseline(USER, { metric: "weight" });
    expect(res.present).toBe(true);
  });

  it("drops a gated metric from the discovery listing", async () => {
    // Discovery is the assistant's map of what exists. Advertising a metric
    // that the fetch will then refuse both leaks that the domain is tracked
    // and sends the assistant down a dead end.
    disableModule("sleep");
    const rows = await metricStatusDiscoveryRows(USER);
    const keys = rows.map((r) => r.metric);
    expect(keys).not.toContain("SLEEP_SCORE");
    expect(keys).not.toContain("BREATHING_DISTURBANCES");
    // …while an unowned metric in the same listing survives.
    expect(MCP_METRIC_STATUS_DISCOVERY.map((s) => s.key)).toContain(
      "FALL_COUNT",
    );
    expect(keys).toContain("FALL_COUNT");
  });
});
