import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { HeroStrip } from "../hero-strip";
import type { DailyBriefing as DailyBriefingPayload } from "@/lib/ai/schema";
import type { HealthScoreReport } from "@/lib/analytics/score/types";

// The "generated" freshness line reads the profile timezone via `useAuth`; stub
// it so the SSR render does not reach for a QueryClient the test omits.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "Europe/Berlin" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

/**
 * Insights hero strip — pins the slots so future polish can't
 * silently drop the greeting / subtitle / baseline meta. v1.18.7
 * removed the coach action row + suggested-prompt strip; the negative
 * tests below pin their absence.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const sampleBriefing: DailyBriefingPayload = {
  paragraph:
    "You're trending well this week. BP is in target band on 9 of 10 readings.",
  keyFindings: [],
};

// The greeting bucket is now computed in the user's configured zone
// (the mocked `Europe/Berlin`), not the host's — so pin explicit UTC
// instants and translate them to the intended Berlin wall-clock hour.
// May 10 2026 is CEST (UTC+2), so Berlin = UTC + 2h.
const morningLocal = new Date("2026-05-10T07:00:00Z"); // 09:00 Berlin
const afternoonLocal = new Date("2026-05-10T12:00:00Z"); // 14:00 Berlin
const eveningLocal = new Date("2026-05-10T18:00:00Z"); // 20:00 Berlin
const SCORE_REPORT: HealthScoreReport = {
  composite: {
    status: "ok",
    value: {
      score: 86,
      band: "green",
      bandSetter: null,
      composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
      noiseFloor: 3,
      scoreVersion: 2,
    },
    coverage: {
      requiredInputs: 3,
      presentInputs: 3,
      historyDays: 28,
      missing: [],
    },
    confidence: { score: 100, band: "high" },
    provenance: {
      inputs: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
      source: "live",
      windowDays: 90,
      computedAt: "2026-05-10T07:00:00.000Z",
    },
  },
  pillars: [],
  delta: 5,
  deltaReason: null,
  scoreVersion: 2,
  weightGoal: {
    status: "insufficient",
    coverage: {
      requiredInputs: 2,
      presentInputs: 0,
      historyDays: 0,
      missing: ["weight reading", "personal weight target"],
    },
    provenance: {
      inputs: ["WEIGHT"],
      source: "none",
      windowDays: 90,
      computedAt: "2026-05-10T07:00:00.000Z",
    },
    reason: "no_personal_goal",
  },
  algorithmNotice: null,
};

describe("<HeroStrip>", () => {
  it("renders the slot wrapper + Dracula gradient utility", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toMatch(/data-slot="insights-hero-strip"/);
    expect(html).toContain("hero-gradient");
    expect(html).toContain("glow-purple");
  });

  it("renders the morning greeting in English", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toMatch(/data-slot="insights-hero-strip-greeting"/);
    expect(html).toContain("Good morning");
  });

  it("renders the H1 at the canonical bold weight and on-scale sizes", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    const greeting = html.match(
      /data-slot="insights-hero-strip-greeting"[^>]*class="([^"]*)"/,
    );
    expect(greeting).not.toBeNull();
    // App H1 weight is bold (UI-STANDARDS §5) — never font-semibold.
    expect(greeting![1]).toContain("font-bold");
    expect(greeting![1]).not.toContain("font-semibold");
    // No off-scale arbitrary type sizes (§5) — round to the neighbouring step.
    expect(greeting![1]).not.toContain("text-[28px]");
    expect(greeting![1]).toContain("sm:text-3xl");
  });

  it("keeps the hero band and its columns on the spacing scale (no step-5)", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    // The band's own padding + the flex column gaps stay on 4/6, never 5.
    expect(html).not.toContain("py-5");
    expect(html).not.toContain("gap-5");
  });

  it("renders the morning greeting in German", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />, "de");
    expect(html).toContain("Guten Morgen");
  });

  it("renders the afternoon greeting in English at 14:00 local", () => {
    const html = render(<HeroStrip briefing={null} now={afternoonLocal} />);
    expect(html).toContain("Good afternoon");
  });

  it("renders the evening greeting in English at 20:00 local", () => {
    const html = render(<HeroStrip briefing={null} now={eveningLocal} />);
    expect(html).toContain("Good evening");
  });

  it("appends the user name to the greeting when supplied", () => {
    const html = render(
      <HeroStrip briefing={null} now={morningLocal} userName="Alex" />,
    );
    expect(html).toContain("Good morning, Alex");
  });

  it("does NOT append a comma when userName is missing", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    // Greeting renders without trailing comma + name.
    expect(html).not.toMatch(/Good morning,\s*</);
  });

  it("uses the briefing paragraph as the subtitle when one is supplied", () => {
    const html = render(
      <HeroStrip briefing={sampleBriefing} now={morningLocal} />,
    );
    expect(html).toMatch(/data-slot="insights-hero-strip-subtitle"/);
    expect(html).toContain(
      "You&#x27;re trending well this week. BP is in target band on 9 of 10 readings.",
    );
  });

  it("falls back to the heroFallbackSubtitle when briefing is null", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toContain(
      "A daily read of your trends, drawn straight from the numbers you&#x27;ve logged.",
    );
  });

  it("renders the personal-baseline meta line", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).toMatch(/data-slot="insights-hero-strip-baseline"/);
    expect(html).toContain("Based on your last 90 days");
  });

  it("renders the freshness caption when updatedAt is supplied", () => {
    // v1.22 — the hero freshness line now uses `formatUpdatedLabel` for parity
    // with the briefing + per-metric cards: a same-day timestamp reads
    // "Updated today, HH:MM" rather than the old relative "Generated … ago".
    // `formatUpdatedLabel` derives "today" from the real clock, so freeze it to a
    // fixed instant and base `updatedAt` on the same instant — otherwise a run
    // that straddles local midnight reads the five-minutes-ago stamp as
    // "yesterday".
    vi.useFakeTimers();
    vi.setSystemTime(morningLocal);
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const html = render(
        <HeroStrip
          briefing={null}
          updatedAt={fiveMinutesAgo}
          now={morningLocal}
        />,
      );
      expect(html).toMatch(/data-slot="insights-hero-strip-generated"/);
      expect(html).toContain("Updated today");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT render the generated caption when updatedAt is missing", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="insights-hero-strip-generated"');
  });

  // ── Action row ─────────────────────────────────────────────────────
  // v1.4.28 retired the weekly-report button — Coach is now the only
  // hero-row action. The weekly-report path is gone from the codebase.
  it("does NOT render a weekly-report action button", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain(
      'data-slot="insights-hero-strip-action-weekly-report"',
    );
  });

  // v1.18.7 — the overview "Ask the coach" action button was removed from
  // the hero band. The Coach lives in the bottom-right drawer (mounted by
  // the insights layout shell), not as a hero affordance.
  it("does NOT render an ask-the-coach action button", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="insights-hero-strip-action-coach"');
  });

  // v1.4.25 W3 — the regenerate button moved from the hero action row
  // to the dedicated `<InsightsTabStrip>` component. The hero strip no
  // longer renders the rerun slot under any prop combination.
  it("does NOT render a regenerate button in the hero action row", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="insights-hero-strip-action-rerun"');
  });

  // ── Suggested prompts strip ────────────────────────────────────────
  // v1.18.7 — the guided-questions chip strip ("Try asking …") was removed
  // from the hero band along with the coach action row.
  it("does NOT mount the SuggestedPrompts strip in the hero band", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="insights-hero-strip-prompts"');
    expect(html).not.toContain('data-slot="insights-suggested-prompts"');
    expect(html).not.toContain("What should I tell my doctor?");
  });

  // ── Misc ───────────────────────────────────────────────────────────
  it("supports the German locale fallback subtitle", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />, "de");
    expect(html).toContain("Täglicher Blick auf deine Trends");
  });

  it("uses the now override deterministically (smoke for greeting-bucket logic)", () => {
    // Buckets are read in the mocked user's Berlin zone: 09:00 → morning,
    // 14:00 → afternoon, 20:00 → evening, 02:00 → night. 00:00 UTC is
    // 02:00 Berlin (CEST).
    const earlyMorning = new Date("2026-05-10T00:00:00Z"); // 02:00 Berlin
    const html = render(<HeroStrip briefing={null} now={earlyMorning} />);
    // Night maps to "Good evening" in EN per the resolver mapping.
    expect(html).toContain("Good evening");
    // Sanity: midnight-bucket sample is NOT "Good morning".
    expect(html).not.toContain("Good morning");
  });

  it("uses the morning bucket at noon-1 (11:59 Berlin boundary)", () => {
    const justBeforeNoon = new Date("2026-05-10T09:59:00Z"); // 11:59 Berlin
    const html = render(<HeroStrip briefing={null} now={justBeforeNoon} />);
    expect(html).toContain("Good morning");
  });

  it("resolves the greeting hour in the user's stored zone, not the browser", () => {
    // 11:30 UTC is still MORNING in UTC but 13:30 (AFTERNOON) in the mocked
    // Berlin user's zone. The afternoon greeting proves the hour comes from
    // the stored zone — the /insights hero used to read the browser clock.
    const utcMorningBerlinAfternoon = new Date("2026-05-10T11:30:00Z");
    const html = render(
      <HeroStrip briefing={null} now={utcMorningBerlinAfternoon} />,
    );
    expect(html).toContain("Good afternoon");
    expect(html).not.toContain("Good morning");
  });

  // ── B4 — Weekly-report banner card ─────────────────────────────────
  // v1.4.28 retired the weekly-report path. The banner, the report
  // route, the schema slot and the i18n keys are gone; the hero
  // strip never paints the banner under any prop combination now.
  it("does not render the weekly-report banner under any prop combination", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="insights-hero-strip-weekly-banner"');
  });

  // ── B5 — Health Score panel ────────────────────────────────────────
  it("does NOT render the Health Score panel when healthScore is omitted", () => {
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain('data-slot="health-score-card"');
  });

  it("renders the Health Score panel when the score is supplied", () => {
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        healthScore={SCORE_REPORT}
      />,
    );
    expect(html).toMatch(/data-slot="health-score-card-compact"/);
    expect(html).toMatch(/data-band="green"/);
    expect(html).toContain(">86<");
  });

  it("does not render any Ask-the-Coach affordance in the hero band", () => {
    // v1.4.27 F8 — the inline HSC Ask-the-Coach button was retired.
    // v1.18.7 — the hero action-row coach button was removed too; the
    // Coach is the bottom-right drawer, not a hero affordance. Neither
    // the score card nor the band surfaces a coach button.
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        healthScore={SCORE_REPORT}
      />,
    );
    expect(html).not.toContain('data-slot="health-score-card-ask-coach"');
    expect(html).not.toContain('data-slot="insights-hero-strip-action-coach"');
  });

  it("uses the lg row layout when healthScore is supplied (smoke test on container class)", () => {
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        healthScore={SCORE_REPORT}
      />,
    );
    // The wrapper picks up the `lg:flex-row` modifier when the score
    // is present so the panel sits beside the title block on desktop.
    expect(html).toContain("lg:flex-row");
  });

  // ── v1.4.28 R3c-Insights — equal-height contract (FB-H1/H2) ───────
  it("stretches the row's cross-axis when the HealthScore card mounts (md+/lg+)", () => {
    // Per Inv-4 the right column painted 75-110 px shorter than the
    // left column on desktop. Switching the parent flex row from
    // `items-start` to `items-stretch` gives the card a stretched
    // shell to grow into. The class is load-bearing for FB-H1/H2 —
    // if a future refactor reverts to `items-start` the height gap
    // returns.
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        healthScore={SCORE_REPORT}
      />,
    );
    expect(html).toContain("md:items-stretch");
    expect(html).toContain("lg:items-stretch");
    expect(html).not.toContain("md:items-start");
  });

  it("does NOT stretch the row when healthScore is omitted", () => {
    // Pin the negative case so a future refactor can't blanket-apply
    // the stretch contract on the no-score layout (no right column
    // means nothing to stretch toward).
    const html = render(<HeroStrip briefing={null} now={morningLocal} />);
    expect(html).not.toContain("md:items-stretch");
  });

  // ── v1.16.8 — score-column reservation while analytics is pending ──
  it("reserves the score column with a skeleton while the payload is pending", () => {
    const html = render(
      <HeroStrip briefing={null} now={morningLocal} healthScorePending />,
    );
    // The placeholder mirrors the card's column footprint so the band
    // paints at its final geometry from the first frame.
    expect(html).toContain('data-slot="health-score-card-skeleton"');
    expect(html).toContain("md:basis-[22rem]");
    expect(html).toContain('aria-hidden="true"');
    // The real card stays absent until the payload lands.
    expect(html).not.toContain('data-slot="health-score-card" ');
  });

  it("keeps the two-column split active while pending", () => {
    const html = render(
      <HeroStrip briefing={null} now={morningLocal} healthScorePending />,
    );
    expect(html).toContain("md:flex-row");
    expect(html).toContain("md:items-stretch");
  });

  it("drops the skeleton once the payload resolves without a score", () => {
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        healthScorePending={false}
      />,
    );
    expect(html).not.toContain('data-slot="health-score-card-skeleton"');
    expect(html).not.toContain("md:items-stretch");
  });

  it("renders the real card, never the skeleton, when a score is present", () => {
    const html = render(
      <HeroStrip
        briefing={null}
        now={morningLocal}
        healthScorePending
        healthScore={SCORE_REPORT}
      />,
    );
    expect(html).toContain('data-slot="health-score-card-compact"');
    expect(html).not.toContain('data-slot="health-score-card-skeleton"');
  });
});
