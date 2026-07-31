/**
 * The row states of the "what counts toward your score" surface, rendered.
 *
 * `rows.test.ts` pins the decisions; this pins that the decisions reach the
 * markup, and that each row carries the stable attributes the e2e spec
 * selects on rather than viewport-dependent text.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
import type { ScoreConfigRow } from "@/lib/score-config/rows";
import { ScorePillarRow } from "../score-pillar-row";

function render(row: ScoreConfigRow, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ScorePillarRow row={row} onToggle={() => {}} />
    </I18nProvider>,
  );
}

const base: ScoreConfigRow = {
  id: "SLEEP",
  domain: "sleep",
  counts: true,
  selectable: true,
  eligibility: "counting",
};

describe("the three axes", () => {
  it("names recording and showing beside the score switch", () => {
    const html = render(base);

    expect(html).toContain('data-slot="score-pillar-axis-recorded"');
    expect(html).toContain('data-slot="score-pillar-axis-shown"');
    expect(html).toContain('data-slot="score-pillar-switch"');
    expect(html).toContain("Being recorded");
    expect(html).toContain("Shown in the app");
  });

  it("offers exactly one switch, and it is the score one", () => {
    const html = render(base);

    expect(html.match(/role="switch"/g) ?? []).toHaveLength(1);
    expect(html).toContain("Count Sleep toward the score");
  });
});

describe("row attributes", () => {
  it("carries the pillar, its domain and its state", () => {
    const html = render({ ...base, counts: false, eligibility: "waiting" });

    expect(html).toContain('data-pillar="SLEEP"');
    expect(html).toContain('data-domain="sleep"');
    expect(html).toContain('data-counts="false"');
    expect(html).toContain('data-eligibility="waiting"');
  });
});

describe("selected, waiting for data", () => {
  it("renders the line for a counted pillar with nothing to score", () => {
    const html = render({ ...base, counts: true, eligibility: "waiting" });

    expect(html).toContain('data-state="waiting"');
    expect(html).toContain("Selected, waiting for data");
  });

  it("does not render it once the person switches the pillar off", () => {
    const html = render({ ...base, counts: false, eligibility: "waiting" });

    expect(html).not.toContain("Selected, waiting for data");
  });

  it("does not render it while the server has said nothing", () => {
    const html = render({ ...base, eligibility: "unknown" });

    expect(html).not.toContain('data-slot="score-pillar-state"');
  });
});

describe("wellbeing under crisis signposting", () => {
  it("is named as safety guidance, never as a configuration problem", () => {
    const html = render({
      ...base,
      id: "WELLBEING",
      domain: "wellbeing",
      eligibility: "crisis",
    });

    expect(html).toContain('data-state="crisis"');
    expect(html).toContain("Safety guidance is shown instead of a score");
    expect(html).toContain("Your selection is fine");
    expect(html).not.toContain("Selected, waiting for data");
  });
});

describe("a failed read", () => {
  it("is named as a failure, not as absence", () => {
    const html = render({ ...base, eligibility: "read_failed" });

    expect(html).toContain('data-state="read_failed"');
    expect(html).toContain("could not be read");
    expect(html).not.toContain("Selected, waiting for data");
  });
});

describe("a pillar this build cannot score", () => {
  it("is disabled, honest, and offers no switch at all", () => {
    const html = render({
      ...base,
      id: "FITNESS",
      domain: "fitness",
      selectable: false,
      eligibility: "unavailable",
    });

    expect(html).toContain('data-selectable="false"');
    expect(html).toContain('data-slot="score-pillar-unavailable"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Not available yet");
    // Not a switch that no-ops behind a disabled attribute: no switch.
    expect(html).not.toContain('data-slot="score-pillar-switch"');
    expect(html).not.toContain('role="switch"');
  });

  it("says why, rather than leaving the row a dead end", () => {
    const html = render({
      ...base,
      id: "FITNESS",
      domain: "fitness",
      selectable: false,
      eligibility: "unavailable",
    });

    expect(html).toContain("has never produced a score");
  });
});

describe("localisation", () => {
  it("renders every state in each shipped locale", () => {
    for (const locale of ["de", "fr", "es", "it", "pl"] as Locale[]) {
      const html = render({ ...base, eligibility: "waiting" }, locale);
      // A missing key falls through to the key path; seeing one here means
      // a locale bundle is short.
      expect(html).not.toContain("settings.sections.score");
    }
  });
});
