import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.32.26 (issue #627) — the manual entry form labels its value field in the
 * user's preferred unit for a type with a metric/imperial transform. A metric
 * user sees "kg"; an imperial user sees "lb". The field is the entry boundary
 * that converts the typed number back to canonical SI on submit, so the label
 * and the stored unit must agree with the preference.
 */

let preference: "metric" | "imperial" = "metric";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "testuser",
      role: "USER",
      unitPreference: preference,
    },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    refetchQueries: vi.fn(),
  }),
}));

vi.mock("@/lib/api/api-fetch", () => ({
  apiPost: vi.fn().mockResolvedValue({}),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MeasurementForm } from "../measurement-form";

function render(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MeasurementForm defaultType="WEIGHT" />
    </I18nProvider>,
  );
}

describe("MeasurementForm — preferred-unit value label", () => {
  it("labels the weight field in kg for a metric user", () => {
    preference = "metric";
    const html = render();
    expect(html).toContain("kg");
    expect(html).not.toContain("lb");
    // The metric placeholder (kg) is shown, not the imperial one.
    expect(html).toContain('placeholder="75.5"');
  });

  it("labels the weight field in lb for an imperial user", () => {
    preference = "imperial";
    const html = render();
    expect(html).toContain("lb");
    // The imperial placeholder (lb) is shown.
    expect(html).toContain('placeholder="165"');
  });
});
