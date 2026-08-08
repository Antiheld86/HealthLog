/**
 * What reaches the screen, not what the strings say.
 *
 * The copy guard reads the bundles; this reads the render. Between them they
 * cover the two halves of the same rule — that the two readings of a day are
 * shown side by side and never merged, that the forecast never appears without
 * its band and its count, and that the deviation is measured against the band
 * rather than against the midpoint.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { PrognosisReading } from "@/lib/analytics/mood-prognosis/read";

import { MoodPrognosisView } from "../mood-prognosis-card";

function render(reading: PrognosisReading): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MoodPrognosisView reading={reading} />
    </I18nProvider>,
  );
}

function present(over: Partial<PrognosisReading> = {}): PrognosisReading {
  return {
    present: true,
    date: "2026-08-07",
    predicted: 5.4,
    ciLow: 4.1,
    ciHigh: 6.8,
    n: 42,
    modelVersion: "mood-ridge-1",
    computedAt: "2026-08-08T02:35:00.000Z",
    ageDays: 1,
    current: true,
    provisional: false,
    stage: "regular",
    entries: 64,
    seasonalUnlocked: false,
    selfAssessment: 6,
    deviation: "within",
    deviationAmount: 0,
    contributions: [
      { feature: "dimension:a2", contribution: 0.9 },
      { feature: "linked:steps", contribution: -0.4 },
    ],
    ...over,
  } as PrognosisReading;
}

describe("<MoodPrognosisView>", () => {
  it("shows both readings, and shows the person's own one first", () => {
    const html = render(present());
    expect(html).toContain('data-slot="mood-prognosis-self"');
    expect(html).toContain('data-slot="mood-prognosis-expected"');
    // The self block precedes the expected block in the document, which is
    // what "the self-assessment leads" means to a screen reader.
    expect(html.indexOf('data-slot="mood-prognosis-self"')).toBeLessThan(
      html.indexOf('data-slot="mood-prognosis-expected"'),
    );
    // Both values are on screen as themselves. A merged single figure is the
    // failure this whole feature is shaped to avoid.
    expect(html).toContain("6.0");
    expect(html).toContain("5.4");
  });

  it("never shows the value without its band and its count", () => {
    const html = render(present());
    expect(html).toContain("4.1");
    expect(html).toContain("6.8");
    expect(html).toContain("42");
  });

  it("phrases the forecast as a counterfactual", () => {
    const html = render(present());
    expect(html).toContain("would have been expected");
    expect(html).not.toContain("your mood is");
  });

  it("measures the deviation against the band, not the midpoint", () => {
    // 6.0 is above the 5.4 midpoint and inside the 4.1-6.8 band, so it is not
    // a finding. A midpoint comparison would have called it one.
    expect(render(present())).toContain("inside that range");

    const above = render(
      present({ selfAssessment: 8, deviation: "above", deviationAmount: 1.2 }),
    );
    expect(above).toContain("1.2 points above");
  });

  it("labels a provisional forecast as provisional", () => {
    expect(render(present({ provisional: true }))).toContain(
      'data-slot="mood-prognosis-provisional"',
    );
    expect(render(present())).not.toContain(
      'data-slot="mood-prognosis-provisional"',
    );
  });

  it("says which day it is about when that day is not today", () => {
    const stale = render(present({ current: false, ageDays: 4 }));
    expect(stale).toContain('data-slot="mood-prognosis-age"');
    // Rendered through the account's own date-order preference rather than as
    // the raw day key — under this render's `en` locale and the default AUTO
    // preference that is month-first. The assertion is on the formatted form
    // precisely because a raw `2026-08-07` on the screen would pass a looser
    // one.
    expect(stale).toContain("08/07/2026");
    expect(stale).not.toContain("2026-08-07");
  });

  it("names what the model weighted, in the reader's own words", () => {
    const html = render(present());
    // The dimension's own label, the one the slider carries.
    expect(html).toContain("Stress");
    expect(html).toContain("Steps");
    expect(html).toContain("counted towards a higher expected value");
    expect(html).toContain("counted towards a lower expected value");
  });

  it("skips a feature key this build no longer knows", () => {
    const html = render(
      present({
        contributions: [
          { feature: "retired:whatever", contribution: 2 },
          { feature: "dimension:a3", contribution: 1 },
        ],
      }),
    );
    expect(html).not.toContain("retired:whatever");
    expect(html).toContain('data-slot="mood-prognosis-explanation"');
  });

  it("renders nothing at all below the first rung", () => {
    expect(
      render({
        present: false,
        reason: "no-output-yet",
        entries: 4,
        nextThreshold: 15,
      }),
    ).toBe("");
  });

  it("explains the learning phase with the count and the next step", () => {
    const html = render({
      present: false,
      reason: "learning-phase",
      entries: 22,
      nextThreshold: 30,
    });
    expect(html).toContain("22");
    expect(html).toContain("30");
    // Absence, not an error and not a zero.
    expect(html).not.toContain('data-slot="mood-prognosis-expected"');
  });

  it("refuses honestly when there are days but no pattern", () => {
    const html = render({
      present: false,
      reason: "no-pattern",
      entries: 140,
      nextThreshold: null,
    });
    expect(html).toContain("140");
    expect(html).not.toContain('data-slot="mood-prognosis-statement"');
  });
});
