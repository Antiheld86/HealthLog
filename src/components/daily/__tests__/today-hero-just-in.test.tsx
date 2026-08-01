/**
 * The Today hero's arrival handling and the reaction line's lead
 * replacement.
 *
 * The hero used to carry a "just in" chip under the score, with the
 * arrival's local time on it. It is gone: under a number, "just in" did
 * not say what had arrived — the score? a reading? — and the clock face
 * changed nothing a person would then do. What is left is the invariant
 * that an arrival alone is not a reason to paint anything, and the one
 * the reaction line has always had.
 *
 * NO LAYOUT SHIFT. The reaction line REPLACES the lead; it is never a
 * second paragraph. The hero stays one lead line tall, so nothing below
 * it moves when the line arrives on a poll.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { TodayHero } from "../today-hero";
import type { DailyDigest } from "@/lib/daily/digest";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const ARRIVED_AT = "2026-07-16T05:41:00.000Z";

function digest(over: Partial<DailyDigest> = {}): DailyDigest {
  return {
    generatedAt: "2026-07-16T06:00:00.000Z",
    phase: "final",
    sleepPending: false,
    score: { value: 82, band: "green", delta: 3 },
    topSignal: null,
    briefingLead: "Your week is trending steady.",
    line: "Your week is trending steady.",
    worthALook: [],
    justIn: null,
    reactionLine: null,
    ...over,
  };
}

/** Any hh:mm clock face — the thing the hero must never print here. */
const CLOCK_FACE = /\d{1,2}:\d{2}/;

describe("TodayHero — an arrival is not a chip", () => {
  it("paints no arrival marker when something has landed", () => {
    const html = render(
      <TodayHero
        digest={digest({ justIn: { kind: "sleep_night", at: ARRIVED_AT } })}
      />,
    );

    expect(html).not.toContain('data-slot="today-hero-just-in"');
    expect(html).not.toContain("Just in");
    expect(html).not.toContain(ARRIVED_AT);
  });

  it("prints no clock face beside the score", () => {
    // The removed chip was the only wall clock on this surface, and a
    // wall clock rendered on the server pass is a hydration mismatch as
    // well as noise. Neither is possible once nothing prints one.
    const html = render(
      <TodayHero
        digest={digest({ justIn: { kind: "weight", at: ARRIVED_AT } })}
      />,
    );

    expect(html).not.toMatch(CLOCK_FACE);
  });

  it("still shows a pending night, which is a different sentence", () => {
    // The freshness note says the day is not complete yet, which changes
    // how the number should be read. That one stays.
    const html = render(
      <TodayHero
        digest={digest({
          phase: "provisional",
          sleepPending: true,
          justIn: { kind: "weight", at: ARRIVED_AT },
        })}
      />,
    );

    expect(html).toContain('data-slot="today-hero-sleep-pending"');
    expect(html).not.toContain('data-slot="today-hero-just-in"');
  });

  it("renders nothing at all for an account whose only news was the arrival", () => {
    // With no chip there is nothing left for such a digest to say, and a
    // bordered empty hero above the tile strip would be worse than
    // absence.
    const html = render(
      <TodayHero
        digest={digest({
          score: null,
          briefingLead: null,
          worthALook: [],
          reactionLine: null,
          justIn: { kind: "sleep_night", at: ARRIVED_AT },
        })}
      />,
    );

    expect(html).not.toContain('data-slot="today-hero"');
  });
});

describe("TodayHero — the reaction line replaces the lead", () => {
  const REACTION = "A solid night, deeper than your recent stretch.";

  it("renders the reaction line instead of the briefing lead", () => {
    const html = render(
      <TodayHero
        digest={digest({
          reactionLine: REACTION,
          briefingLead: "Your week is trending steady.",
        })}
      />,
    );

    expect(html).toContain(REACTION);
    // The lead it replaced must be GONE, not pushed down into a second block.
    expect(html).not.toContain("Your week is trending steady.");
  });

  it("stays exactly one lead line tall — no second paragraph, no shift", () => {
    const html = render(
      <TodayHero
        digest={digest({
          reactionLine: REACTION,
          briefingLead: "Your week is trending steady.",
        })}
      />,
    );

    const leadSlots = html.split('data-slot="today-hero-lead"').length - 1;
    expect(leadSlots).toBe(1);
  });

  it("falls back to the briefing lead when no line was generated", () => {
    const html = render(
      <TodayHero
        digest={digest({
          reactionLine: null,
          briefingLead: "Your week is trending steady.",
        })}
      />,
    );
    expect(html).toContain("Your week is trending steady.");
  });

  it("still renders for an otherwise-bare account when a line exists", () => {
    // The one moment this surface exists for must not be swallowed by the
    // empty-account degrade.
    const html = render(
      <TodayHero
        digest={digest({
          score: null,
          briefingLead: null,
          worthALook: [],
          reactionLine: REACTION,
          justIn: { kind: "weight", at: ARRIVED_AT },
        })}
      />,
    );

    expect(html).toContain('data-slot="today-hero"');
    expect(html).toContain(REACTION);
  });
});
