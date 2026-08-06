import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS } from "@/lib/record-settings";
import { ALL_METRICS } from "@/lib/validations/thresholds";

import { ManagedRecordSettingsForm } from "../managed-record-settings-section";

const render = (
  family: Parameters<typeof ManagedRecordSettingsForm>[0]["family"],
  settings: Record<string, unknown>,
) =>
  renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ManagedRecordSettingsForm
        disabled={false}
        family={family}
        onSave={vi.fn()}
        saveLabel="Save"
        settings={settings}
      />
    </I18nProvider>,
  );

describe("managed record settings forms", () => {
  it.each([
    ["profile", { timezone: "Europe/Berlin" }, "managed-display-name"],
    ["modules", { modulePreferences: { mood: true } }, "mood"],
    [
      "notifications",
      {
        moodReminderEnabled: true,
        notificationPreferences: {
          medication: { lowStockRunwayDays: 7, reorderLeadDays: 10 },
          mood: { reminderHour: 22 },
        },
      },
      "managed-reminder-hour",
    ],
    [
      "thresholds",
      { overrides: { WEIGHT: { min: 55, max: 80 } } },
      "managed-threshold-metric",
    ],
    [
      "coach",
      { disableCoach: false, preferences: { tone: "warm" } },
      "managed-coach-tone",
    ],
    [
      "insights",
      {
        layout: {
          version: 2,
          tiles: [{ id: "weight", visible: true, order: 0 }],
        },
      },
      "tile-order-weight",
    ],
  ] as const)(
    "renders labeled %s controls without an internal JSON editor",
    (family, settings, control) => {
      const html = render(family, settings);

      expect(html).toContain(control);
      expect(html).toContain("Save");
      expect(html).not.toContain("<textarea");
    },
  );

  it("renders every direct module and threshold metric for a fresh record", () => {
    const modules = render("modules", { modulePreferences: {} });
    const thresholds = render("thresholds", {
      overrides: {},
      effective: Object.fromEntries(
        ALL_METRICS.map((metric) => [
          metric,
          { range: { greenMin: 10, greenMax: 20 } },
        ]),
      ),
    });

    for (const module of Object.keys(MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS)) {
      expect(modules).toContain(`name="${module}"`);
    }
    for (const metric of ALL_METRICS) {
      expect(thresholds).toContain(`value="${metric}"`);
    }
    expect(thresholds).toContain('value="10"');
    expect(thresholds).toContain('value="20"');
  });
});
