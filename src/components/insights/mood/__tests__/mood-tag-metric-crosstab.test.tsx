import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  MoodTagMetricCrosstab,
  type MoodTagMetricCrosstabRow,
} from "../mood-tag-metric-crosstab";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function row(
  over: Partial<MoodTagMetricCrosstabRow> = {},
): MoodTagMetricCrosstabRow {
  return {
    tag: "alcohol",
    labelKey: "mood.tag.alcohol",
    label: null,
    categoryKey: "consumption",
    icon: "Wine",
    metricKey: "nextDayRestingHeartRate",
    display: "bpm",
    mode: "nextDay",
    withDays: 12,
    withoutDays: 14,
    withAvg: 62.4,
    withoutAvg: 54.1,
    delta: 8.3,
    pValue: 0.002,
    qValue: 0.02,
    confidence: "high",
    ...over,
  };
}

describe("<MoodTagMetricCrosstab>", () => {
  it("renders nothing for an empty list", () => {
    expect(render(<MoodTagMetricCrosstab rows={[]} />)).toBe("");
  });

  it("labels a next-day resting-heart-rate row and prints its bpm unit", () => {
    const html = render(<MoodTagMetricCrosstab rows={[row()]} />);
    expect(html).toContain("Next-day resting heart rate");
    expect(html).toContain("+8.3 bpm");
    expect(html).toContain('data-metric="nextDayRestingHeartRate"');
  });

  it("labels a next-day HRV row and prints its ms unit", () => {
    const html = render(
      <MoodTagMetricCrosstab
        rows={[
          row({
            metricKey: "nextDayHeartRateVariability",
            display: "ms",
            withAvg: 38.2,
            withoutAvg: 55.6,
            delta: -17.4,
          }),
        ]}
      />,
    );
    expect(html).toContain("Next-day heart-rate variability");
    expect(html).toContain("-17.4 ms");
    expect(html).toContain('data-metric="nextDayHeartRateVariability"');
  });

  it("captions a next-day row with the day-after wording", () => {
    const html = render(<MoodTagMetricCrosstab rows={[row()]} />);
    expect(html).toContain("the day after the 12 days you tagged this");
  });

  // The board mixes metrics of opposite valence — a higher next-day resting
  // heart rate is worse, a higher active energy is better — so the delta
  // read-out must stay neutral rather than assert a verdict in colour.
  it("keeps the delta read-out neutral instead of colouring it by sign", () => {
    const up = render(<MoodTagMetricCrosstab rows={[row()]} />);
    const down = render(
      <MoodTagMetricCrosstab rows={[row({ delta: -8.3 })]} />,
    );
    for (const html of [up, down]) {
      expect(html).not.toContain("var(--success)");
      expect(html).not.toContain("var(--destructive)");
    }
    expect(up).toContain('data-direction="up"');
    expect(down).toContain('data-direction="down"');
  });
});
