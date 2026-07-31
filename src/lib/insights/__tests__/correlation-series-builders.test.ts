import { describe, it, expect } from "vitest";

import {
  buildComplianceDailySeries,
  buildSymptomSeverityDailySeries,
  type SymptomDayLogRow,
  type SymptomEpisodeSpan,
} from "../correlation-series-builders";
import {
  discoverCorrelations,
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
  type NamedSeries,
} from "../correlation-discovery";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";

/** Minimal slot ledger row at a UTC instant with a given status. */
function slot(at: string, status: DoseHistoryRow["status"]): DoseHistoryRow {
  return { kind: "slot", at: new Date(at), status } as DoseHistoryRow;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("buildComplianceDailySeries", () => {
  it("computes a per-day rate pooled across slots, keyed in the user tz", () => {
    const rows: DoseHistoryRow[] = [
      // 2026-03-02 (Berlin): 1 taken, 1 missed → 50%.
      slot("2026-03-02T07:00:00Z", "taken_on_time"),
      slot("2026-03-02T19:00:00Z", "missed"),
      // 2026-03-03 (Berlin): both taken → 100%.
      slot("2026-03-03T07:00:00Z", "taken_on_time"),
      slot("2026-03-03T19:00:00Z", "taken_late"),
    ];
    const series = buildComplianceDailySeries(rows, "Europe/Berlin");
    expect(series.key).toBe(MEDICATION_COMPLIANCE_CHANNEL_KEY);
    expect(series.role).toBe("behaviour");
    expect(series.points).toEqual([
      { day: "2026-03-02", value: 50 },
      { day: "2026-03-03", value: 100 },
    ]);
  });

  it("re-keys late-night instants into the correct user-tz day (not UTC)", () => {
    // 2026-03-02T23:30Z is 2026-03-03 00:30 in Berlin (UTC+1) — must bucket on
    // the Berlin day, proving the day-key is tz-aware, not a UTC slice.
    const rows: DoseHistoryRow[] = [
      slot("2026-03-02T23:30:00Z", "taken_on_time"),
    ];
    const series = buildComplianceDailySeries(rows, "Europe/Berlin");
    expect(series.points).toEqual([{ day: "2026-03-03", value: 100 }]);
  });

  it("excludes skipped / upcoming / ad-hoc rows from the denominator", () => {
    const rows: DoseHistoryRow[] = [
      slot("2026-03-02T07:00:00Z", "taken_on_time"),
      slot("2026-03-02T12:00:00Z", "skipped"),
      slot("2026-03-02T19:00:00Z", "upcoming"),
      {
        kind: "ad_hoc",
        at: new Date("2026-03-02T15:00:00Z"),
        status: "ad_hoc",
      } as DoseHistoryRow,
    ];
    const series = buildComplianceDailySeries(rows, "Europe/Berlin");
    // Only the one taken slot counts → 100%, denominator 1.
    expect(series.points).toEqual([{ day: "2026-03-02", value: 100 }]);
  });

  it("degrades to an empty series when no resolved slots exist", () => {
    const rows: DoseHistoryRow[] = [
      slot("2026-03-02T07:00:00Z", "skipped"),
      slot("2026-03-02T19:00:00Z", "upcoming"),
    ];
    const series = buildComplianceDailySeries(rows, "Europe/Berlin");
    expect(series.points).toHaveLength(0);
  });
});

describe("buildSymptomSeverityDailySeries", () => {
  const tz = "Europe/Berlin";

  it("zero-fills healthy days only across a real episode span", () => {
    // Episode runs 2026-03-01 → 2026-03-05. Logs: impact 2 on the 2nd, 3 on the
    // 3rd. The other in-span days fill to 0 (healthy).
    const windowStart = new Date("2026-02-01T00:00:00Z");
    const windowEnd = new Date("2026-03-31T00:00:00Z");
    const episodes: SymptomEpisodeSpan[] = [
      {
        onsetAt: new Date("2026-03-01T08:00:00Z"),
        resolvedAt: new Date("2026-03-05T08:00:00Z"),
      },
    ];
    const dayLogs: SymptomDayLogRow[] = [
      { day: "2026-03-02", impact: 2 },
      { day: "2026-03-03", impact: 3 },
    ];
    const series = buildSymptomSeverityDailySeries({
      dayLogs,
      episodes,
      tz,
      windowStart,
      windowEnd,
      role: "outcome",
    });
    expect(series.key).toBe(SYMPTOM_SEVERITY_CHANNEL_KEY);
    expect(series.role).toBe("outcome");
    const byDay = new Map(series.points.map((p) => [p.day, p.value]));
    // Span days 01..05 present; logged days carry their impact, others 0.
    expect(byDay.get("2026-03-01")).toBe(0);
    expect(byDay.get("2026-03-02")).toBe(2);
    expect(byDay.get("2026-03-03")).toBe(3);
    expect(byDay.get("2026-03-04")).toBe(0);
    expect(byDay.get("2026-03-05")).toBe(0);
    // A day far outside the span is NOT fabricated.
    expect(byDay.has("2026-02-15")).toBe(false);
    // Genuine variance exists (0 ↔ >0), so the series is usable by Pearson.
    const values = series.points.map((p) => p.value);
    expect(Math.max(...values)).toBeGreaterThan(Math.min(...values));
  });

  it("degrades to an empty series when the user has no episodes", () => {
    const series = buildSymptomSeverityDailySeries({
      dayLogs: [],
      episodes: [],
      tz,
      windowStart: new Date("2026-02-01T00:00:00Z"),
      windowEnd: new Date("2026-03-31T00:00:00Z"),
      role: "outcome",
    });
    expect(series.points).toHaveLength(0);
  });

  it("clamps an ongoing episode (null resolvedAt) to the window end", () => {
    const windowStart = new Date("2026-03-01T00:00:00Z");
    const windowEnd = new Date("2026-03-04T00:00:00Z");
    const episodes: SymptomEpisodeSpan[] = [
      { onsetAt: new Date("2026-03-02T08:00:00Z"), resolvedAt: null },
    ];
    const series = buildSymptomSeverityDailySeries({
      dayLogs: [{ day: "2026-03-02", impact: 1 }],
      episodes,
      tz,
      windowStart,
      windowEnd,
      role: "outcome",
    });
    const days = series.points.map((p) => p.day);
    // Span clamps to windowEnd (03-04); no day past it is fabricated.
    expect(days).toContain("2026-03-02");
    expect(days).toContain("2026-03-04");
    expect(days.every((d) => d <= "2026-03-04")).toBe(true);
  });
});

describe("integration — built series flow through the discovery gates", () => {
  const tz = "Europe/Berlin";

  it("a sparse, thin-overlap compliance series produces NO confident driver", () => {
    // Only ~8 days of compliance data: below the n ≥ 20 floor → withheld.
    const rows: DoseHistoryRow[] = [];
    for (let i = 0; i < 8; i++) {
      const day = new Date(Date.UTC(2026, 2, 1 + i, 7, 0, 0));
      rows.push(
        slot(day.toISOString(), i % 2 === 0 ? "taken_on_time" : "missed"),
      );
    }
    const compliance = buildComplianceDailySeries(rows, tz);

    // A symptom outcome over the same thin span.
    const episodes: SymptomEpisodeSpan[] = [
      {
        onsetAt: new Date("2026-03-01T08:00:00Z"),
        resolvedAt: new Date("2026-03-09T08:00:00Z"),
      },
    ];
    const symptom = buildSymptomSeverityDailySeries({
      dayLogs: Array.from({ length: 8 }, (_, i) => ({
        day: `2026-03-0${i + 1}`,
        impact: i % 2 === 0 ? 0 : 2,
      })),
      episodes,
      tz,
      windowStart: new Date("2026-02-01T00:00:00Z"),
      windowEnd: new Date("2026-03-31T00:00:00Z"),
      role: "outcome",
    });

    const result = discoverCorrelations([compliance, symptom], {
      locale: "en",
    });
    expect(result.pairsTested).toBe(0);
    expect(result.discovered).toHaveLength(0);
  });

  it("a sufficient adherence-dip → symptom-flare built series surfaces the link", () => {
    // 50 days of daily compliance + a 50-day episode span with logged flares on
    // low-adherence days → a discoverable next-day link.
    const start = Date.UTC(2026, 0, 1, 7, 0, 0);
    const rows: DoseHistoryRow[] = [];
    const dayLogs: SymptomDayLogRow[] = [];
    for (let i = 0; i < 50; i++) {
      const at = new Date(start + i * MS_PER_DAY);
      const low = i % 3 === 2; // every third day is a big adherence dip
      rows.push(slot(at.toISOString(), low ? "missed" : "taken_on_time"));
      // Symptom on day D+1 flares after a dip on day D.
      const prevLow = i > 0 && (i - 1) % 3 === 2;
      const dayKey = new Date(start + i * MS_PER_DAY)
        .toISOString()
        .slice(0, 10);
      dayLogs.push({ day: dayKey, impact: prevLow ? 3 : 0 });
    }
    const compliance = buildComplianceDailySeries(rows, tz);
    const symptom = buildSymptomSeverityDailySeries({
      dayLogs,
      episodes: [
        {
          onsetAt: new Date(start),
          resolvedAt: new Date(start + 50 * MS_PER_DAY),
        },
      ],
      tz,
      windowStart: new Date(start - 5 * MS_PER_DAY),
      windowEnd: new Date(start + 55 * MS_PER_DAY),
      role: "outcome",
    });

    const result = discoverCorrelations([compliance, symptom], {
      locale: "en",
    });
    const pair = result.discovered.find(
      (p) =>
        p.behaviour === MEDICATION_COMPLIANCE_CHANNEL_KEY &&
        p.outcome === SYMPTOM_SEVERITY_CHANNEL_KEY,
    );
    expect(pair).toBeDefined();
    expect(pair!.n).toBeGreaterThanOrEqual(20);
    expect(pair!.r).toBeLessThan(0); // higher adherence → lower next-day symptom
    expect(pair!.interpretation).toMatch(/not a cause/);
  });

  it("the two built channels keep the never-causal framing", () => {
    const series: NamedSeries[] = [
      buildComplianceDailySeries(
        Array.from({ length: 40 }, (_, i) =>
          slot(
            new Date(Date.UTC(2026, 0, 1 + i, 7)).toISOString(),
            i % 4 === 0 ? "missed" : "taken_on_time",
          ),
        ),
        tz,
      ),
    ];
    // Pair against a vital with a clean linear lag so a driver surfaces.
    const start = Date.UTC(2026, 0, 1);
    series.push({
      key: "RESTING_HEART_RATE",
      role: "outcome",
      points: Array.from({ length: 40 }, (_, i) => ({
        day: new Date(start + i * MS_PER_DAY).toISOString().slice(0, 10),
        value: 55 + (i > 0 && (i - 1) % 4 === 0 ? 8 : 0) + (i % 2) * 0.1,
      })),
    });
    const result = discoverCorrelations(series, { locale: "en" });
    for (const p of result.discovered) {
      expect(p.interpretation).toMatch(/not a cause|never a cause/);
    }
  });
});
