/**
 * D3-H1 coverage — the clinical safety floors are ONE source of truth.
 *
 * Before v1.21.0 the "is this BP a crisis?" floors lived in three modules with
 * a divergent diastolic value (notification engine + Coach 180/120, a third
 * surface 180/110), so a 170/112 reading read as a crisis in one place and
 * never tripped the alarm. This suite pins that every consumer now resolves the
 * SAME canonical constants from `@/lib/clinical-floors`, so the surfaces can
 * never drift apart again without a test failure.
 */
import { describe, it, expect } from "vitest";

import {
  BP_SYS_CRITICAL,
  BP_DIA_CRITICAL,
  BP_SYS_HYPOTENSIVE_FLOOR,
  GLUCOSE_HYPO_FLOOR,
  GLUCOSE_HYPO_SEVERE_FLOOR,
  GLUCOSE_HYPER_FLOOR,
  FEVER_BAND_C,
  FEVER_RED_FLAG_C,
  SPO2_RED_FLAG_PCT,
} from "@/lib/clinical-floors";
import {
  BP_SYS_HYPERTENSIVE,
  BP_DIA_HYPERTENSIVE,
  BP_SYS_HYPOTENSIVE,
  GLUCOSE_HYPO,
  GLUCOSE_HYPO_SEVERE,
  GLUCOSE_HYPER,
} from "@/lib/illness/safety-floors";
import { getMetricStatusMeta } from "@/lib/insights/metric-status-registry";

describe("clinical-floors — single source of truth", () => {
  it("uses the guideline-correct hypertensive-crisis floors (180/120)", () => {
    // ACC/AHA hypertensive-urgency floor: the diastolic floor is 120, not the
    // 110 one surface once used to raise a banner on calmer readings.
    expect(BP_SYS_CRITICAL).toBe(180);
    expect(BP_DIA_CRITICAL).toBe(120);
  });

  it("safety-floors notification engine re-exports the canonical constants", () => {
    expect(BP_SYS_HYPERTENSIVE).toBe(BP_SYS_CRITICAL);
    expect(BP_DIA_HYPERTENSIVE).toBe(BP_DIA_CRITICAL);
    expect(BP_SYS_HYPOTENSIVE).toBe(BP_SYS_HYPOTENSIVE_FLOOR);
    expect(GLUCOSE_HYPO).toBe(GLUCOSE_HYPO_FLOOR);
    expect(GLUCOSE_HYPO_SEVERE).toBe(GLUCOSE_HYPO_SEVERE_FLOOR);
    expect(GLUCOSE_HYPER).toBe(GLUCOSE_HYPER_FLOOR);
  });

  it("the status registry's fever band binds to the canonical FEVER_BAND_C", () => {
    expect(getMetricStatusMeta("BODY_TEMPERATURE")?.feverBandC).toBe(
      FEVER_BAND_C,
    );
  });

  it("the single-reading fever band sits below the sustained-fever escalation", () => {
    // Two intentional lines for two questions — but both from one module, so
    // they are visibly a pair (D3-L1), not unrelated magic numbers.
    expect(FEVER_BAND_C).toBeLessThan(FEVER_RED_FLAG_C);
  });

  it("keeps the documented glucose + SpO2 floors stable", () => {
    expect(GLUCOSE_HYPO_FLOOR).toBe(70);
    expect(GLUCOSE_HYPO_SEVERE_FLOOR).toBe(54);
    expect(GLUCOSE_HYPER_FLOOR).toBe(250);
    expect(SPO2_RED_FLAG_PCT).toBe(92);
  });
});
