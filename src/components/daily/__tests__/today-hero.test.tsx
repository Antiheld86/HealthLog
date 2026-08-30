import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { TodayHero } from "../today-hero";
import type { DailyDigest } from "@/lib/daily/digest";
import type { PriorityItem } from "@/lib/daily/priority-item";
import { SCORE_VERSION } from "@/lib/analytics/score/types";

// The hero now wires the coach check-in card's keep / let-go taps through
// `useCoachCheckinAction`, so it needs a QueryClient in the tree.
function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const doseItem: PriorityItem = {
  kind: "dose_window",
  title: "Medication due",
  body: "Ramipril is due today.",
  status: "warning",
  actions: [
    {
      labelKey: "daily.action.logDose",
      intent: "dose.log",
      href: "/medications",
    },
  ],
  moduleKey: "medications",
};

const syncItem: PriorityItem = {
  kind: "sync_issue",
  title: "Sync needs attention",
  body: "Withings isn't syncing.",
  status: "warning",
  actions: [
    {
      labelKey: "daily.action.reconnect",
      intent: "sync.reconnect",
      href: "/settings/integrations",
    },
  ],
};

function digest(over: Partial<DailyDigest> = {}): DailyDigest {
  return {
    generatedAt: "2026-07-16T06:00:00.000Z",
    phase: "final",
    sleepPending: false,
    score: {
      value: 82,
      band: "green",
      delta: 3,
      deltaReason: null,
      scoreVersion: SCORE_VERSION,
      composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
    },
    topSignal: {
      sourceMetric: "bp",
      tone: "watch",
      headline: "Blood pressure a touch high this morning",
      nudge: "Take it again after a calm five minutes.",
      delta: "+6 mmHg vs your 30-day average",
    },
    briefingLead: "Your week is trending steady.",
    line: "Your week is trending steady.",
    worthALook: [doseItem, syncItem],
    justIn: null,
    reactionLine: null,
    ...over,
  };
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("<TodayHero>", () => {
  it("renders the score, the lead read, and the worth-a-look rail", () => {
    const html = render(<TodayHero digest={digest()} />);
    expect(html).toContain('data-slot="today-hero"');
    expect(html).toContain('data-phase="final"');
    // Score ring paints its populated (final) face with the server band.
    expect(html).toContain('data-slot="today-hero-score"');
    expect(html).toContain('data-band="green"');
    expect(html).not.toContain('data-provisional="true"');
    // The day's read lead.
    expect(html).toContain("Your week is trending steady.");
    // The top signal headline + its delta.
    expect(html).toContain("Blood pressure a touch high this morning");
    expect(html).toContain("+6 mmHg vs your 30-day average");
    // The rail with both priority cards.
    expect(html).toContain('data-slot="today-hero-rail"');
    expect(html).toContain('data-kind="dose_window"');
    expect(html).toContain('data-kind="sync_issue"');
    // The score delta chip.
    expect(html).toContain('data-slot="today-hero-score-delta"');
  });

  it("does not present a suppressed algorithm jump as score movement", () => {
    const html = render(
      <TodayHero
        digest={digest({
          score: {
            value: 82,
            band: "green",
            delta: 20,
            deltaReason: "algorithm_changed",
            scoreVersion: SCORE_VERSION,
            composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
          },
        })}
      />,
    );
    expect(html).not.toContain('data-slot="today-hero-score-delta"');
  });

  it("wires each PriorityItem action to its existing destination via href", () => {
    const html = render(<TodayHero digest={digest()} />);
    // Every S1 rail action carries an href, so PriorityCard renders it as a
    // link to the existing surface — S2 invents no new backend action.
    expect(html).toContain('href="/medications"');
    expect(html).toContain('href="/settings/integrations"');
    // The score ring is the one door to Insights — the separate
    // read-the-full-briefing link was redundant with it and is gone.
    expect(html).toContain('href="/insights"');
    expect(html).not.toContain('data-slot="today-hero-briefing-link"');
  });

  it("shows the honest sleep-pending note and provisional score", () => {
    const html = render(
      <TodayHero
        digest={digest({
          phase: "provisional",
          sleepPending: true,
          score: null,
          briefingLead: null,
          line: "Your health score today is 82.",
          worthALook: [doseItem],
        })}
      />,
    );
    expect(html).toContain('data-phase="provisional"');
    expect(html).toContain('data-slot="today-hero-sleep-pending"');
    expect(html).toContain("Last night");
    // Null score → the ring's provisional face, never a zero.
    expect(html).toContain('data-provisional="true"');
    // The score ring stays the only route to Insights.
    expect(html).not.toContain('data-slot="today-hero-briefing-link"');
  });

  it("keeps the useful loaded narrative without repeating the ring's numeric score", () => {
    const html = render(
      <TodayHero
        digest={digest({
          briefingLead:
            "Your health score is 82. Your week is trending steady.",
          line: "Your health score is 82. Your week is trending steady.",
        })}
      />,
    );
    const text = visibleText(html);

    expect(text).toContain("Your week is trending steady.");
    expect(text.match(/\b82\b/g)).toHaveLength(1);
    expect(html).toContain('data-slot="today-hero-score"');
    expect(html).toContain('data-slot="today-hero-lead"');
  });

  it("promotes the top signal when score de-duplication removes the only lead", () => {
    const html = render(
      <TodayHero
        digest={digest({
          briefingLead: "Your health score is 82.",
          line: "Your health score is 82.",
          topSignal: {
            sourceMetric: "pulse",
            tone: "info",
            headline: "Pulse is settling lately",
            nudge: "",
            delta: null,
          },
        })}
      />,
    );

    expect(html).toContain('data-slot="today-hero-lead"');
    expect(html).toContain("Pulse is settling lately");
    expect(html).not.toContain('data-slot="today-hero-signal"');
  });

  it("does not invent a score narrative while the digest is provisional", () => {
    const html = render(
      <TodayHero
        digest={digest({
          phase: "provisional",
          sleepPending: true,
          score: null,
          briefingLead: null,
          reactionLine: null,
          line: "Your health score today is 82.",
          worthALook: [doseItem],
        })}
      />,
    );

    expect(html).toContain('data-slot="today-hero-sleep-pending"');
    expect(html).toContain('data-provisional="true"');
    expect(html).not.toContain("Your health score today is 82.");
    expect(html).not.toContain('data-slot="today-hero-lead"');
  });

  it("degrades to nothing on a genuinely empty account", () => {
    const html = render(
      <TodayHero
        digest={digest({
          score: null,
          topSignal: null,
          briefingLead: null,
          line: "Nothing needs your attention today — everything's tracking normally.",
          worthALook: [],
        })}
      />,
    );
    // No score, no items, no cached briefing lead → the hero renders nothing
    // rather than an alarming empty card (the tile strip carries the
    // add-your-first-reading empty state).
    expect(html).toBe("");
  });

  it("shows all-clear when layout filtering removes every candidate", () => {
    const html = render(
      <TodayHero
        digest={digest({
          score: null,
          topSignal: null,
          briefingLead: null,
          line: "Nothing needs your attention today — everything's tracking normally.",
          worthALook: [],
          reactionLine: null,
          justIn: null,
        })}
        renderFilteredAllClear
      />,
    );

    expect(html).toContain('data-slot="today-hero"');
    expect(html).toContain('data-slot="today-hero-all-clear"');
    expect(html).not.toContain('data-slot="today-hero-rail"');
    expect(html).not.toContain('data-slot="today-hero-signal"');
    expect(html).not.toContain('data-slot="today-hero-just-in"');
  });

  // v1.29.1 — the v1.29.0 selected-score-ring cluster was removed from the web
  // hero (Marc, live-use: uneven, wasted tile space). Only the main
  // health-score ring paints now; the cluster's data-slots are gone.
  it("renders no score-ring cluster — only the health-score ring", () => {
    const html = render(<TodayHero digest={digest()} />);
    expect(html).not.toContain('data-slot="today-hero-ring-cluster"');
    expect(html).not.toContain('data-slot="today-hero-ring"');
    // The health-score ring alone still paints, exactly as before.
    expect(html).toContain('data-slot="today-hero-score"');
  });

  it("shows the first-class all-clear line when a score is present but nothing is notable", () => {
    const html = render(
      <TodayHero
        digest={digest({
          worthALook: [],
        })}
      />,
    );
    expect(html).toContain('data-slot="today-hero"');
    expect(html).toContain('data-slot="today-hero-all-clear"');
    expect(html).not.toContain('data-slot="today-hero-rail"');
  });

  it("uses the compact score-only composition when all-clear has no narrative", () => {
    const html = render(
      <TodayHero
        digest={digest({
          topSignal: null,
          briefingLead: null,
          reactionLine: null,
          line: "Your health score today is 82.",
          worthALook: [],
        })}
      />,
    );
    const text = visibleText(html);

    expect(html).toContain('data-layout="compact-all-clear"');
    expect(html).toContain('data-slot="today-hero-all-clear"');
    expect(html).not.toContain('data-slot="today-hero-lead"');
    expect(html).toContain('style="width:120px;height:120px"');
    // The compact fallback keeps exactly one score face: the ring.
    expect(text.match(/\b82\b/g)).toHaveLength(1);
  });

  it("keeps the full narrative composition and md score ring when a lead exists", () => {
    const html = render(
      <TodayHero
        digest={digest({
          topSignal: null,
          worthALook: [],
        })}
      />,
    );

    expect(html).toContain('data-layout="narrative"');
    expect(html).toContain('data-slot="today-hero-lead"');
    expect(html).toContain('style="width:168px;height:168px"');
    expect(html).not.toContain('data-layout="compact-all-clear"');
  });

  // The hero primary-content preference (`hero` on the dashboard layout
  // blob): "reminders" promotes the worth-a-look rail into the hero slot;
  // the score composition stays the default.
  it("promotes the rail into the hero slot when the preference is reminders", () => {
    const html = render(
      <TodayHero digest={digest()} primaryContent="reminders" />,
    );
    expect(html).toContain('data-slot="today-hero"');
    expect(html).toContain('data-layout="reminders"');
    expect(html).toContain('data-slot="today-hero-rail"');
    expect(html).toContain('data-kind="dose_window"');
    expect(html).toContain('data-kind="sync_issue"');
    // The score composition yields the slot entirely.
    expect(html).not.toContain('data-slot="today-hero-score"');
    expect(html).not.toContain('data-slot="today-hero-lead"');
    expect(html).not.toContain('data-slot="today-hero-signal"');
  });

  it("keeps the score composition when the preference is the default score", () => {
    const html = render(<TodayHero digest={digest()} primaryContent="score" />);
    expect(html).toContain('data-slot="today-hero-score"');
    expect(html).toContain('data-slot="today-hero-rail"');
    expect(html).not.toContain('data-layout="reminders"');
  });

  it("shows the calm all-clear line when reminders mode has nothing to surface", () => {
    const html = render(
      <TodayHero
        digest={digest({ worthALook: [] })}
        primaryContent="reminders"
      />,
    );
    expect(html).toContain('data-layout="reminders"');
    expect(html).toContain('data-slot="today-hero-all-clear"');
    expect(html).not.toContain('data-slot="today-hero-rail"');
    expect(html).not.toContain('data-slot="today-hero-score"');
  });

  it("keeps the honest sleep-pending note in reminders mode", () => {
    const html = render(
      <TodayHero
        digest={digest({ phase: "provisional", sleepPending: true })}
        primaryContent="reminders"
      />,
    );
    expect(html).toContain('data-slot="today-hero-sleep-pending"');
  });

  it("still degrades to nothing on a genuinely empty account in reminders mode", () => {
    const html = render(
      <TodayHero
        digest={digest({
          score: null,
          topSignal: null,
          briefingLead: null,
          worthALook: [],
        })}
        primaryContent="reminders"
      />,
    );
    expect(html).toBe("");
  });
});

/**
 * v1.38 — the hero's ring shows the number and nothing else, so a score
 * resting on one area of health would look here exactly like one resting
 * on five. The basis line is the whole difference; it is stated only
 * below the recommended breadth, in the hero's quiet tier, and it never
 * touches the ring itself.
 */
describe("<TodayHero> score basis", () => {
  function withBasis(
    domains: number,
    tier: "full" | "partial" | "minimal",
  ): DailyDigest {
    return digest({
      score: {
        value: 82,
        band: "green",
        delta: 3,
        deltaReason: null,
        scoreVersion: SCORE_VERSION,
        composition: ["BLOOD_PRESSURE"],
        scoreBasis: { domains, recommended: 3, tier, physiological: true },
      },
    });
  }

  it("says what a two-area score rests on", () => {
    const html = render(<TodayHero digest={withBasis(2, "partial")} />);
    expect(html).toContain('data-slot="today-hero-score-basis"');
    expect(visibleText(html)).toContain("Based on 2 of 3 areas of health.");
  });

  it("leaves the ring's own face untouched", () => {
    const html = render(<TodayHero digest={withBasis(1, "minimal")} />);
    // Same band, same populated face, same delta chip as a full-breadth
    // day: the line is scope, not a downgrade.
    expect(html).toContain('data-band="green"');
    expect(html).not.toContain('data-provisional="true"');
    expect(html).toContain('data-slot="today-hero-score-delta"');
    expect(visibleText(html)).toContain("82");
  });

  it("says nothing once the recommended breadth is met", () => {
    const html = render(<TodayHero digest={withBasis(3, "full")} />);
    expect(html).not.toContain('data-slot="today-hero-score-basis"');
  });

  it("says nothing for a digest carrying no basis at all", () => {
    // An older cached digest. The hero never counts areas out of
    // `composition` — three pillars can be one area.
    const html = render(<TodayHero digest={digest()} />);
    expect(html).not.toContain('data-slot="today-hero-score-basis"');
  });

  it("says nothing when there is no score to rest on anything", () => {
    const html = render(<TodayHero digest={digest({ score: null })} />);
    expect(html).not.toContain('data-slot="today-hero-score-basis"');
  });
});
