/**
 * What the mood correlation card is allowed to claim.
 *
 * The card used to paint a "Strong" badge from any coefficient it was handed,
 * as long as five days had been paired. The coefficient itself now clears the
 * significance bar before it leaves the server, so the card's job here is the
 * other half: when the bar refuses, say which bar and how far off the reader
 * is, rather than falling back to the same "not enough paired data" blank that
 * a reader with no data at all sees.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  MoodCorrelationCards,
  type MoodMetricCorrelationData,
} from "../mood-correlation-cards";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const NOTHING: MoodMetricCorrelationData = {
  result: null,
  points: [],
  n: 0,
  suppressed: "insufficientPairs",
};

/** The sleep card's own markup — the four siblings carry their own copy. */
function renderSleep(sleep: MoodMetricCorrelationData) {
  const html = render(
    <MoodCorrelationCards
      sleep={sleep}
      steps={NOTHING}
      pulse={NOTHING}
      weight={NOTHING}
      bloodPressureSystolic={NOTHING}
    />,
  );
  const start = html.indexOf('data-kind="sleep"');
  const end = html.indexOf('data-kind="steps"');
  return html.slice(start, end);
}

describe("<MoodCorrelationCards>", () => {
  it("shows no strength badge for a refused correlation", () => {
    const html = renderSleep({
      result: null,
      points: Array.from({ length: 5 }, (_, i) => ({ x: i, y: i })),
      n: 5,
      suppressed: "insufficientPairs",
    });

    expect(html).not.toContain("Strong");
    expect(html).not.toContain("Moderate");
  });

  it("names how many paired days are still missing instead of a bare blank", () => {
    const html = renderSleep({
      result: null,
      points: Array.from({ length: 5 }, (_, i) => ({ x: i, y: i })),
      n: 5,
      suppressed: "insufficientPairs",
    });

    // The reader is told where they stand, not only that something is absent.
    expect(html).toContain("5 of 20");
  });

  it("keeps the plain empty copy when nothing has been paired at all", () => {
    const html = renderSleep(NOTHING);

    expect(html).toContain("Not enough paired data yet");
    expect(html).not.toContain("0 of 20");
  });

  it("says a twenty-day pairing showed no reliable link", () => {
    const html = renderSleep({
      result: null,
      points: Array.from({ length: 20 }, (_, i) => ({ x: i, y: i })),
      n: 20,
      suppressed: "notSignificant",
    });

    expect(html).toContain("No clear link");
    expect(html).not.toContain("Not enough paired data yet");
    expect(html).not.toContain("Weak");
  });

  it("still shows the badge and the n · r caption for a correlation that cleared the bar", () => {
    const html = renderSleep({
      result: { r: 0.82, strength: "stark", n: 24 },
      points: Array.from({ length: 24 }, (_, i) => ({ x: i, y: i })),
      n: 24,
    });

    expect(html).toContain("Strong");
    expect(html).toContain("24 paired days");
  });
});
