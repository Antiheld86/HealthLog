import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pickHrvSummary } from "@/components/dashboard/dashboard-gates";
import {
  SUMMARY_TYPE_MODULE,
  disabledSummaryTypes,
} from "@/lib/dashboard/widget-modules";
import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";
import type { DataSummary } from "@/lib/analytics/trends";

/**
 * The dashboard HRV tile must accept either HRV type.
 *
 * HRV is stored under two measurement types that are not the same measure:
 * SDNN (`HEART_RATE_VARIABILITY`, Apple / Fitbit / Google Health) and nightly
 * RMSSD (`HRV_RMSSD`, Oura / Polar / WHOOP, and a bridge pushing a Garmin-style
 * feed). Every other HRV surface already unions them — `/insights/hrv` via
 * `fallbackMeasurementType`, the Coach via `COACH_SOURCE_MEASUREMENT_TYPES.hrv`,
 * the MCP reads via `withHrvFallback` — and `sub-page-metric.ts` states that
 * listing both is what keeps "the tab, pill, and dashboard tile lit whichever
 * source the user has".
 *
 * The tile did not. It read `summaries.HEART_RATE_VARIABILITY` alone, so an
 * RMSSD-only account got a Settings → Dashboard toggle that turned on and
 * rendered nothing, with no message, while `/insights/hrv` charted the same
 * readings. That asymmetry is what this file pins.
 *
 * Mutation check: return the fallback unconditionally and the "SDNN wins"
 * cases go red; drop the fallback arm and the RMSSD cases go red; return the
 * fallback's TYPE while returning the primary's summary and the freshness
 * case goes red.
 */
function summary(count: number, latest: number): DataSummary {
  return {
    count,
    latest,
    min: latest,
    max: latest,
    mean: latest,
    median: latest,
    avg7: latest,
    avg30: latest,
    slope30: 0,
  } as unknown as DataSummary;
}

describe("pickHrvSummary", () => {
  it("takes SDNN when the account has it", () => {
    const picked = pickHrvSummary({
      HEART_RATE_VARIABILITY: summary(12, 48),
    });
    expect(picked.type).toBe("HEART_RATE_VARIABILITY");
    expect(picked.summary?.latest).toBe(48);
  });

  it("falls back to RMSSD for a ring / strap account", () => {
    // The regression itself: pre-fix this returned undefined, `hasHrv` was
    // false, and the tile never rendered however the widget was toggled.
    const picked = pickHrvSummary({ HRV_RMSSD: summary(30, 42) });
    expect(picked.type).toBe("HRV_RMSSD");
    expect(picked.summary?.latest).toBe(42);
  });

  it("prefers SDNN when the account carries both series", () => {
    // The case a naive `sdnn ?? rmssd` written the wrong way round breaks.
    // Both are stored in ms but they measure different things, so the tile
    // shows one series, never a blend, and SDNN is the primary.
    const picked = pickHrvSummary({
      HEART_RATE_VARIABILITY: summary(9, 55),
      HRV_RMSSD: summary(30, 42),
    });
    expect(picked.type).toBe("HEART_RATE_VARIABILITY");
    expect(picked.summary?.latest).toBe(55);
  });

  it("treats a present-but-empty SDNN summary as absent", () => {
    // The slice can carry a zero-count summary for a type the account has no
    // rows for. Keying off presence rather than `count` would pin the tile to
    // an empty SDNN series and re-break the ring user.
    const picked = pickHrvSummary({
      HEART_RATE_VARIABILITY: summary(0, 0),
      HRV_RMSSD: summary(30, 42),
    });
    expect(picked.type).toBe("HRV_RMSSD");
    expect(picked.summary?.count).toBe(30);
  });

  it("reports no series, on the primary type, when the account has neither", () => {
    // The tile is hidden either way; reporting the fallback type here would
    // make an account with no HRV at all look like a ring user to the label
    // and the freshness lookup.
    // Annotated: inferred from the literals alone, `{}` widens to
    // `{ HRV_RMSSD?: undefined }`, which the index signature rejects.
    const inputs: (Record<string, DataSummary> | undefined)[] = [
      undefined,
      {},
      { HRV_RMSSD: summary(0, 0) },
    ];
    for (const input of inputs) {
      const picked = pickHrvSummary(input);
      expect((picked.summary?.count ?? 0) > 0).toBe(false);
      expect(picked.type).toBe("HEART_RATE_VARIABILITY");
    }
  });

  it("does not gate on the recovery module itself", () => {
    // The gate belongs server-side (see the sibling test below), so a second
    // one here would be a competing source of truth. Scoped to the function
    // body: the docblock above it legitimately explains where gating lives.
    const src = readFileSync(
      join(process.cwd(), "src/components/dashboard/dashboard-gates.ts"),
      "utf8",
    );
    const body = src.slice(src.indexOf("export function pickHrvSummary("));
    expect(body).not.toMatch(/modules|recovery|isModuleEnabled/i);
  });
});

describe("the RMSSD fallback cannot leak recovery-module data", () => {
  it("drops HRV_RMSSD from the snapshot summaries when recovery is off", () => {
    // The half of this fix that is easy to miss. `HRV_RMSSD` is recovery-owned
    // in `METRIC_STATUS_MODULE_OWNERS`, which governs the metric-status and
    // MCP reads — but the dashboard snapshot gates off `SUMMARY_TYPE_MODULE`,
    // a DIFFERENT map, and that one did not list it. Inert while the tile read
    // SDNN alone; the moment the tile falls back to RMSSD it would show a
    // recovery-off account a tile built from recovery-owned rows.
    expect(disabledSummaryTypes({ recovery: false })).toContain("HRV_RMSSD");
    // SDNN is a plain vital and stays ungated — turning recovery off must not
    // take the ordinary HRV tile away from an Apple / Fitbit account.
    expect(disabledSummaryTypes({ recovery: false })).not.toContain(
      "HEART_RATE_VARIABILITY",
    );
    // And nothing is dropped when the module is on.
    expect(disabledSummaryTypes({ recovery: true }).size).toBe(0);
  });

  it("keeps the fallback aligned with the metric-status owner map", () => {
    // The two maps answer different questions and are allowed to differ, but
    // not for THIS type: a fallback that serves data the primary path refuses
    // is exactly what `METRIC_STATUS_MODULE_OWNERS` documents as the hazard.
    expect(moduleForMeasurementType("HRV_RMSSD")).toBe("recovery");
    expect(SUMMARY_TYPE_MODULE.HRV_RMSSD).toBe("recovery");
  });
});

describe("the tile wiring follows the chosen series", () => {
  const PAGE = readFileSync(
    join(process.cwd(), "src/app/page-client.tsx"),
    "utf8",
  );

  it("sources the HRV summary from the helper, not a bare SDNN lookup", () => {
    expect(PAGE).toContain("pickHrvSummary(");
    // The exact line the bug lived on. If it comes back, so does the bug.
    expect(PAGE).not.toContain(
      "const hrvSummary = data?.summaries?.HEART_RATE_VARIABILITY",
    );
  });

  it("reads freshness off the type actually shown", () => {
    // A hardcoded SDNN lookup here captions a live RMSSD tile as stale.
    expect(PAGE).toContain("staleDays={tileStaleDays(hrvType)}");
    expect(PAGE).not.toContain('tileStaleDays("HEART_RATE_VARIABILITY")');
  });

  it("names the measure when the RMSSD series is the one on show", () => {
    // Mirrors how `/insights/hrv` appends `· RMSSD` to its chart title, so a
    // 20-60 ms RMSSD reading is not mistaken for a collapsed SDNN one.
    expect(PAGE).toContain('hrvType === "HRV_RMSSD"');
    expect(PAGE).toContain("· RMSSD");
  });
});
