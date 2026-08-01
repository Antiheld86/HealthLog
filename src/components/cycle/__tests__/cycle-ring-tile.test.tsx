import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { CalendarResponse, CycleVerdict } from "../types";

/**
 * v1.15.3 — the compact cycle ring as a wellness-strip tile.
 *
 * The tile is mounted ONLY when `user.cycleTrackingEnabled` is true (a
 * page-level gate the Insights page owns, mirroring the summary card); these
 * tests cover the tile's own behaviour given that gate: it sources the phase +
 * cycle day from the SAME server-resolved `verdict` the wheel reads,
 * renders the cycle ring labelled, deep-links to the cycle page, and stays
 * silent while resolving / on a hard error / when there is no active cycle so
 * the wellness strip never shows a half-painted dial (no gap, no placeholder).
 *
 * The calendar read is mocked at the hook boundary so the SSR snapshot is
 * deterministic without a TanStack-Query client / network round-trip.
 */

// `next/link` → a plain anchor in the static snapshot.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const calendarState = vi.hoisted(() => ({
  current: {
    data: undefined as CalendarResponse | undefined,
    isLoading: false,
    isError: false,
  },
}));

vi.mock("../use-cycle", async () => {
  const actual =
    await vi.importActual<typeof import("../use-cycle")>("../use-cycle");
  return {
    ...actual,
    useCycleCalendar: () => calendarState.current,
  };
});

import { CycleRingTile } from "../cycle-ring-tile";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

/** The verdict the server would resolve for that grid: LUTEAL, cycle day 3. */
const LUTEAL_VERDICT: CycleVerdict = {
  state: "IN_CYCLE",
  dayOfCycle: 3,
  cycleLength: 28,
  phase: "LUTEAL",
  spans: [
    { phase: "MENSTRUAL", fraction: 5 / 28 },
    { phase: "FOLLICULAR", fraction: 7 / 28 },
    { phase: "OVULATORY", fraction: 2 / 28 },
    { phase: "LUTEAL", fraction: 14 / 28 },
  ],
  cycleStartDate: null,
  overdueDays: null,
  daysUntilNext: null,
  fertileWindow: { start: null, end: null, active: false },
};

/** The verdict for an account with nothing to say about today. */
const NO_CYCLE_VERDICT: CycleVerdict = {
  state: "INSUFFICIENT_DATA",
  dayOfCycle: null,
  cycleLength: null,
  phase: null,
  spans: [],
  cycleStartDate: null,
  overdueDays: null,
  daysUntilNext: null,
  fertileWindow: { start: null, end: null, active: false },
};

/** A calendar read whose SERVER-RESOLVED verdict puts today on LUTEAL, day 3. */
function lutealCalendar(today: string): CalendarResponse {
  const days = [
    { date: shift(today, -2), phase: "MENSTRUAL" as const },
    { date: shift(today, -1), phase: "FOLLICULAR" as const },
    { date: today, phase: "LUTEAL" as const },
  ];
  return {
    days: days as unknown as CalendarResponse["days"],
    profile: {} as CalendarResponse["profile"],
    prediction: null,
    verdict: LUTEAL_VERDICT,
  } as CalendarResponse;
}

function shift(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

beforeEach(() => {
  calendarState.current = { data: undefined, isLoading: false, isError: false };
});

describe("<CycleRingTile>", () => {
  it("renders the cycle ring, phase label, and deep-link for an active cycle", () => {
    calendarState.current = {
      data: lutealCalendar(todayYmd()),
      isLoading: false,
      isError: false,
    };

    const html = render(<CycleRingTile />);

    // The wellness-strip tile chrome + the compact cycle ring.
    expect(html).toContain('data-slot="wellness-cycle-tile"');
    expect(html).toContain('data-slot="cycle-ring"');
    expect(html).toContain('data-phase="LUTEAL"');
    // The phase band word + the strip-tile label.
    expect(html).toContain("Luteal");
    expect(html).toContain("Cycle");
    // Deep-link into the cycle page.
    expect(html).toContain('href="/cycle"');
  });

  it("renders nothing while the calendar read is still resolving", () => {
    calendarState.current = {
      data: undefined,
      isLoading: true,
      isError: false,
    };
    expect(render(<CycleRingTile />)).toBe("");
  });

  it("renders nothing on a hard calendar read error", () => {
    calendarState.current = {
      data: undefined,
      isLoading: false,
      isError: true,
    };
    expect(render(<CycleRingTile />)).toBe("");
  });

  it("renders nothing when there is no active cycle today", () => {
    // A resolved calendar with no phase on today → no active cycle.
    const empty: CalendarResponse = {
      days: [] as unknown as CalendarResponse["days"],
      profile: {} as CalendarResponse["profile"],
      prediction: null,
      verdict: NO_CYCLE_VERDICT,
    } as CalendarResponse;
    calendarState.current = { data: empty, isLoading: false, isError: false };
    expect(render(<CycleRingTile />)).toBe("");
  });
});
