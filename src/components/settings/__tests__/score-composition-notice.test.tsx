/**
 * The settings half of the composition note.
 *
 * Its subject is the one change on this page nobody made: the person did
 * not touch the rows below it, the method did not move, and the number is
 * different anyway. So the two things worth pinning are that it names the
 * pillars in the reader's own language, and that it never borrows the
 * recipe note's sentences — telling someone they changed something they did
 * not change is worse than saying nothing, which is what shipped before.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
import type { ScorePillarId } from "@/lib/analytics/score/types";
import { ScoreCompositionNotice } from "../score-composition-notice";

function render(
  props: { left: ScorePillarId[]; joined: ScorePillarId[] },
  locale: Locale = "en",
): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ScoreCompositionNotice
        left={props.left}
        joined={props.joined}
        onDismiss={() => {}}
      />
    </I18nProvider>,
  );
}

describe("a pillar that stopped counting on its own", () => {
  it("names the pillar and says the number moved for that reason", () => {
    const html = render({ left: ["SLEEP"], joined: [] });

    expect(html).toContain('data-slot="score-composition-notice"');
    expect(html).toContain("What counts changed on its own");
    expect(html).toContain("Sleep");
    expect(html).toContain("not because your health did");
  });

  it("never says the person changed anything", () => {
    const html = render({ left: ["SLEEP"], joined: [] });

    expect(html).not.toContain("You changed what counts");
    expect(html).not.toContain("What counts is now yours to choose");
  });

  it("says nothing about a pillar that joined when none did", () => {
    const html = render({ left: ["SLEEP"], joined: [] });

    expect(html).not.toContain("Now counting toward your score");
  });
});

describe("both directions at once", () => {
  it("names what left and what arrived, each once", () => {
    const html = render({ left: ["SLEEP"], joined: ["LIPIDS"] });

    expect(html).toContain("Sleep");
    expect(html).toContain("Lipids");
    expect(html).toContain("Now counting toward your score");
  });
});

describe("the reader's own language", () => {
  it("carries the German copy with its umlauts", () => {
    const html = render({ left: ["SLEEP"], joined: [] }, "de");

    expect(html).toContain("Was zählt, hat sich von selbst geändert");
    expect(html).not.toContain("What counts changed on its own");
  });

  it("keeps the Korean register the rest of the page uses", () => {
    const html = render({ left: ["SLEEP"], joined: [] }, "ko");

    expect(html).toContain("반영 항목이 저절로 바뀌었어요");
    expect(html).not.toContain("What counts changed on its own");
  });
});

describe("acknowledging it", () => {
  it("offers the same dismiss the recipe note offers", () => {
    const html = render({ left: ["SLEEP"], joined: [] });

    expect(html).toContain('data-slot="score-composition-notice-dismiss"');
    expect(html).toContain("Got it");
  });
});
