import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ManagedRecordSettingsForm } from "../managed-record-settings-section";

const render = (
  family: Parameters<typeof ManagedRecordSettingsForm>[0]["family"],
  settings: Record<string, unknown>,
) =>
  renderToStaticMarkup(
    <ManagedRecordSettingsForm
      disabled={false}
      family={family}
      onSave={vi.fn()}
      saveLabel="Save"
      settings={settings}
    />,
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
});
