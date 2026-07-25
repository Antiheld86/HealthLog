/**
 * Settings → Gesundheitsakte: what the export panel opens with.
 *
 * Two things are seeded from `/api/auth/me` during render — the practice name
 * and the saved selection. The seed runs during render because a `useState`
 * initialiser would read `undefined` while `useAuth` is still resolving and
 * stick, and it is gated on the user id so a late re-resolve never clobbers
 * edits in flight.
 *
 * The three panel states are the load-bearing part. First run must open the
 * picker EXPANDED with the named template applied and the fenced tier visibly
 * empty, so the user presses Generate having seen twelve named groups; a
 * repeat run must open collapsed carrying the owner's own last scope. A
 * template silently applied behind a collapsed disclosure would be opt-out
 * wearing a hat.
 *
 * SSR-only, per the project convention for this surface.
 *
 * Mutation checks:
 *   - remove the seeding block → "pre-fills the input" and "restores the saved
 *     selection" go red.
 *   - start `pickerOpen` at `false` → "opens expanded on the first run" goes
 *     red.
 *   - add a fenced leaf to `STANDARD_TEMPLATE_LEAVES` → "checks no fenced leaf
 *     on the first run" goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { AuthUser } from "@/hooks/use-auth";

const authSpy = vi.fn<() => { user: AuthUser | null }>();
vi.mock("@/hooks/use-auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/use-auth")>(
      "@/hooks/use-auth",
    );
  return { ...actual, useAuth: () => authSpy() };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { HealthRecordExportPanel } from "../report-selection/selection-panel";

function buildUser(lastReportPracticeName: string | null): AuthUser {
  return {
    id: "user-1",
    username: "user",
    email: null,
    role: "USER",
    heightCm: null,
    dateOfBirth: null,
    gender: null,
    timezone: "Europe/Berlin",
    onboardingCompletedAt: null,
    onboardingTourCompleted: true,
    onboardingTourProgress: null,
    avatarUrl: null,
    glucoseUnit: null,
    unitPreference: "metric",
    timeFormat: "AUTO",
    dateFormat: "AUTO",
    disableCoach: false,
    fullName: null,
    insurerName: null,
    insurerIkNumber: null,
    insuranceNumber: null,
    lastReportPracticeName,
    reportSelection: null,
    cycleTrackingEnabled: false,
    modules: {},
  } as AuthUser;
}

function withSavedSelection(user: AuthUser, leaves: string[]): AuthUser {
  return {
    ...user,
    reportSelection: {
      v: 2,
      leaves,
      format: "fhir",
      rangeDays: 180,
      includeCharts: false,
    },
  } as AuthUser;
}

/**
 * Whether a leaf row renders as checked. Only the fenced tier and an expanded
 * group render leaf rows at all — a collapsed group shows its count chip
 * instead, which is the point of the two-interaction repeat path.
 */
function leafChecked(html: string, leaf: string): boolean {
  const row = html.match(
    new RegExp(`data-testid="report-leaf-${leaf}"[\\s\\S]*?</label>`),
  )?.[0];
  if (!row) return false;
  return /data-state="checked"/.test(row);
}

/** The "n/total" chip a collapsed group row carries. */
function groupChip(html: string, group: string): string | null {
  const row = html.match(
    new RegExp(`data-testid="report-group-row-${group}"[\\s\\S]*?</div>`),
  )?.[0];
  return row?.match(/data-slot="tag-chip"[^>]*>([^<]*)</)?.[1] ?? null;
}

function renderPanel(user: AuthUser | null): string {
  authSpy.mockReturnValue({ user });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <HealthRecordExportPanel />
    </I18nProvider>,
  );
}

function practiceInputValue(html: string): string | null {
  const input = html.match(/<input[^>]*id="hr-practice"[^>]*>/)?.[0];
  if (!input) return null;
  return input.match(/value="([^"]*)"/)?.[1] ?? "";
}

describe("<HealthRecordExportPanel> — remembered practice name", () => {
  it("pre-fills the input with the last-used practice name", () => {
    const html = renderPanel(buildUser("Sample Practice"));
    expect(practiceInputValue(html)).toBe("Sample Practice");
  });

  it("leaves the input empty when no name was ever remembered", () => {
    const html = renderPanel(buildUser(null));
    expect(practiceInputValue(html)).toBe("");
  });

  it("leaves the input empty while the auth payload is still resolving", () => {
    const html = renderPanel(null);
    expect(practiceInputValue(html)).toBe("");
  });
});

describe("<HealthRecordExportPanel> — the first run", () => {
  it("opens the picker expanded and names the template it applied", () => {
    const html = renderPanel(buildUser(null));
    expect(html).toContain('data-testid="health-record-included-data-panel"');
    expect(html).toContain('data-testid="report-scope-picker"');
    expect(html).toContain("Standard doctor&#x27;s report");
  });

  it("counts the template's leaves per group, and no others", () => {
    const html = renderPanel(buildUser(null));
    // Identity: both leaves. Vitals: the three classic ones out of seven.
    // Body: weight and BMI out of twelve. Nothing at all from the groups the
    // template leaves alone.
    expect(groupChip(html, "identity")).toBe("2/2");
    expect(groupChip(html, "vitals")).toBe("3/7");
    expect(groupChip(html, "body")).toBe("2/12");
    expect(groupChip(html, "labs")).toBe("1/1");
    expect(groupChip(html, "medications")).toBe("2/4");
    expect(groupChip(html, "history")).toBe("2/2");
    expect(groupChip(html, "cardio")).toBe("0/14");
    expect(groupChip(html, "activity")).toBe("0/8");
    expect(groupChip(html, "sleepRecovery")).toBe("0/16");
    expect(groupChip(html, "mobility")).toBe("0/11");
    expect(groupChip(html, "environment")).toBe("0/4");
  });

  it("leaves every fenced leaf unchecked and renders the tier", () => {
    const html = renderPanel(buildUser(null));
    expect(html).toContain('data-testid="report-sensitive-tier"');
    for (const leaf of [
      "MOOD",
      "CYCLE",
      "FAMILY_HISTORY",
      "PHQ9_SCORE",
      "GAD7_SCORE",
      "WHO5_SCORE",
      "SCI_SCORE",
    ]) {
      expect(leafChecked(html, leaf), leaf).toBe(false);
    }
  });

  it("gives the fenced tier no group checkbox", () => {
    const html = renderPanel(buildUser(null));
    expect(html).toContain('data-testid="report-group-check-vitals"');
    expect(html).not.toContain('data-testid="report-group-check-sensitive"');
  });

  it("states the scope in one line", () => {
    const html = renderPanel(buildUser(null));
    expect(html).toContain('data-testid="report-scope-summary"');
    expect(html).toContain("14 entries from 7 areas");
  });
});

describe("<HealthRecordExportPanel> — a repeat run", () => {
  it("restores the saved selection and collapses the picker", () => {
    const html = renderPanel(
      withSavedSelection(buildUser("Sample Practice"), [
        "RESTING_HEART_RATE",
        "MOOD",
      ]),
    );
    expect(html).not.toContain(
      'data-testid="health-record-included-data-panel"',
    );
    // The scope line still says what will be in the document, and it names the
    // fenced inclusion rather than folding it into the count.
    expect(html).toContain("2 entries from 2 areas");
    expect(html).toContain("incl. Mood");
  });

  it("restores the saved format and range", () => {
    const html = renderPanel(withSavedSelection(buildUser(null), ["WEIGHT"]));
    // FHIR was saved, so the practice-name line (PDF only) is not rendered.
    expect(practiceInputValue(html)).toBeNull();
    expect(html).toContain('<option value="180" selected=""');
  });

  it("falls back to the template when the saved blob cannot be read", () => {
    const user = {
      ...buildUser(null),
      reportSelection: { bp: true, weight: true },
    } as AuthUser;
    const html = renderPanel(user);
    // A shape the server cannot read is not consent to anything, so the panel
    // shows the named template rather than a partial scope.
    expect(html).toContain("Standard doctor&#x27;s report");
    expect(groupChip(html, "body")).toBe("2/12");
  });
});
