import { describe, expect, it } from "vitest";

import {
  MANAGED_RECORD_SETTINGS_FIELD_ALLOWLIST,
  parseManagedRecordSettingsPatch,
} from "@/lib/record-settings/configuration";

describe("managed record settings configuration contract", () => {
  it("enumerates the only target-record fields each settings DTO may write", () => {
    expect(MANAGED_RECORD_SETTINGS_FIELD_ALLOWLIST).toEqual({
      profile: [
        "displayName",
        "heightCm",
        "dateOfBirth",
        "gender",
        "locale",
        "timezone",
        "unitPreference",
        "timeFormat",
        "dateFormat",
      ],
      modules: ["modulePreferences"],
      notifications: ["moodReminderEnabled", "notificationPreferences"],
      thresholds: ["overrides"],
      coach: ["disableCoach", "preferences"],
      insights: ["layout"],
    });
  });

  it.each([
    ["profile", { email: "not-allowed@example.test" }],
    ["modules", { role: "ADMIN" }],
    [
      "notifications",
      {
        notificationPreferences: { medication: { deliveryDefault: "client" } },
      },
    ],
    ["thresholds", { glucoseUnit: "imperial" }],
    ["coach", { memories: [] }],
    ["insights", { provider: "external" }],
  ] as const)("rejects a disallowed %s field", (family, patch) => {
    expect(() => parseManagedRecordSettingsPatch(family, patch)).toThrow();
  });

  it.each([
    [
      "profile",
      {
        displayName: "Managed profile",
        heightCm: 120,
        dateOfBirth: "2016-04-03",
        gender: "OTHER",
        locale: "en",
        timezone: "Europe/Berlin",
        unitPreference: "metric",
        timeFormat: "H24",
        dateFormat: "DMY",
      },
    ],
    ["modules", { modulePreferences: { mood: false } }],
    [
      "notifications",
      {
        moodReminderEnabled: true,
        notificationPreferences: {
          medication: { lowStockRunwayDays: 7, reorderLeadDays: 10 },
          mood: { reminderHour: 22 },
        },
      },
    ],
    ["thresholds", { overrides: { WEIGHT: { min: 55, max: 80 } } }],
    [
      "coach",
      {
        disableCoach: false,
        preferences: {
          tone: "warm",
          verbosity: "default",
          excludeMetrics: [],
          showEvidenceByDefault: false,
          defaultWindow: "allTime",
        },
      },
    ],
    [
      "insights",
      {
        layout: {
          version: 2,
          tiles: [{ id: "weight", visible: true, order: 0 }],
        },
      },
    ],
  ] as const)("accepts a typed %s patch", (family, patch) => {
    expect(() => parseManagedRecordSettingsPatch(family, patch)).not.toThrow();
  });
});
