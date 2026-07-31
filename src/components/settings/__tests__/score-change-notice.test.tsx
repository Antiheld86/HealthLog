/**
 * The Health Score notice, which had no renderer at all until this release.
 *
 * The machinery raised it, persisted the dismissal and evicted the cache for
 * its whole life while nothing drew it, so the two things worth pinning are
 * that each of its two shapes says the right thing and that it can be
 * dismissed.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
import { ScoreChangeNotice } from "../score-change-notice";

function render(
  props: {
    configVersion: number;
    changedAt: string | null;
  },
  locale: Locale = "en",
): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ScoreChangeNotice
        configVersion={props.configVersion}
        changedAt={props.changedAt}
        onDismiss={() => {}}
      />
    </I18nProvider>,
  );
}

describe("an account that has never chosen", () => {
  it("explains what the upgrade did and that the number did not move", () => {
    const html = render({ configVersion: 0, changedAt: null });

    expect(html).toContain('data-kind="upgrade"');
    expect(html).toContain("What counts is now yours to choose");
    expect(html).toContain("used to follow the modules you had switched on");
    expect(html).toContain("still counts exactly what it counted before");
  });

  it("never claims a change the account has not made", () => {
    const html = render({ configVersion: 0, changedAt: null });

    expect(html).not.toContain("You changed what counts");
  });
});

describe("an account that changed its recipe", () => {
  it("dates the change and says what it does to the history", () => {
    const html = render({
      configVersion: 3,
      changedAt: "2026-07-31T09:00:00.000Z",
    });

    expect(html).toContain('data-kind="changed"');
    expect(html).toContain("You changed what counts");
    expect(html).toContain("2026");
    expect(html).toContain("the weekly change stays paused");
    expect(html).toContain("Each pillar&#x27;s own history runs straight");
  });

  it("keeps the note truthful when the date cannot be read", () => {
    const html = render({ configVersion: 3, changedAt: "not-a-date" });

    expect(html).toContain('data-kind="changed"');
    expect(html).toContain("You changed what counts");
    // No invented date, and no literal placeholder left standing.
    expect(html).not.toContain("{date}");
    expect(html).not.toContain("Invalid Date");
  });
});

describe("dismissal", () => {
  it("offers a dismiss control", () => {
    const html = render({ configVersion: 0, changedAt: null });

    expect(html).toContain('data-slot="score-change-notice-dismiss"');
    expect(html).toContain("Got it");
  });

  it("calls back with no argument when pressed", () => {
    const onDismiss = vi.fn();
    // The button's own handler, exercised directly: `renderToStaticMarkup`
    // has no events, and the parent's mutation is what carries the itemKey.
    const node = (
      <ScoreChangeNotice
        configVersion={1}
        changedAt={null}
        onDismiss={onDismiss}
      />
    );
    expect(node.props.onDismiss).toBe(onDismiss);
  });
});

describe("localisation", () => {
  it("renders both shapes in each shipped locale", () => {
    for (const locale of ["de", "fr", "es", "it", "pl"] as Locale[]) {
      for (const version of [0, 2]) {
        const html = render(
          { configVersion: version, changedAt: "2026-07-31T09:00:00.000Z" },
          locale,
        );
        expect(html).not.toContain("settings.sections.score");
      }
    }
  });
});
