/**
 * Settings → Gesundheitsakte: the practice name is remembered between reports.
 *
 * `User.lastReportPracticeName` is persisted by the export route after a
 * successful generation and rides the `/api/auth/me` payload. This suite pins
 * the read half: the panel opens pre-filled with the last-used name instead of
 * asking for the clinic name again on every report.
 *
 * SSR-only, per the project convention for this surface (node environment,
 * no `@testing-library/react`). The seed runs during render — a `useState`
 * initializer would read `undefined` while `useAuth` is still resolving and
 * stick at empty — so the static markup already carries the seeded value.
 *
 * Mutation check: revert the seeding block in the panel and the first case
 * goes red.
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
import { HealthRecordExportPanel } from "../health-record-export-panel";

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
    cycleTrackingEnabled: false,
    modules: {},
  } as AuthUser;
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
