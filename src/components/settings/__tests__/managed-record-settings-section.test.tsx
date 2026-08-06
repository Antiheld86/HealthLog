import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS } from "@/lib/record-settings";
import { ALL_METRICS } from "@/lib/validations/thresholds";

import { ManagedRecordSettingsForm } from "../managed-record-settings-section";

const LOCALES = ["de", "en", "es", "fr", "it", "pl"] as const;

const render = (
  family: Parameters<typeof ManagedRecordSettingsForm>[0]["family"],
  settings: Record<string, unknown>,
  locale: (typeof LOCALES)[number] = "en",
) =>
  renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
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

    for (const moduleKey of Object.keys(
      MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS,
    )) {
      expect(modules).toContain(`name="${moduleKey}"`);
    }
    for (const metric of ALL_METRICS) {
      expect(thresholds).toContain(`value="${metric}"`);
    }
    expect(thresholds).toContain('value="10"');
    expect(thresholds).toContain('value="20"');
  });

  it("uses localized display inventories instead of raw Coach and Insight IDs", () => {
    for (const locale of LOCALES) {
      const coach = render(
        "coach",
        {
          preferences: {
            excludeMetrics: ["bp"],
            dataClusters: ["cardio"],
          },
        },
        locale,
      );
      const insights = render(
        "insights",
        {
          layout: {
            version: 2,
            sections: [{ id: "unknown-section", visible: true, order: 0 }],
            tiles: [{ id: "unknown-tile", visible: true, order: 0 }],
          },
        },
        locale,
      );

      expect(coach).not.toContain(">bp<");
      expect(coach).not.toContain(">cardio<");
      expect(insights).not.toContain(">unknown-section<");
      expect(insights).not.toContain(">unknown-tile<");
      expect(insights).not.toContain("settings.sharedRecord");
    }
  });

  it.each(["toString", "constructor", "__proto__"])(
    "renders the unavailable label for prototype property %s",
    (id) => {
      const coach = render("coach", {
        preferences: {
          excludeMetrics: [id],
          dataClusters: [id],
        },
      });
      const insights = render("insights", {
        layout: {
          version: 2,
          sections: [{ id, visible: true, order: 0 }],
          tiles: [{ id, visible: true, order: 0 }],
        },
      });

      expect(coach).not.toContain(`>${id}<`);
      expect(insights).toContain("Unavailable insight");
      expect(insights).not.toContain(`>${id}<`);
      expect(insights).not.toContain("settings.sharedRecord");
    },
  );
});
