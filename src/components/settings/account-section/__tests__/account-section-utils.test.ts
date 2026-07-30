import { describe, it, expect } from "vitest";
import {
  describeRejectedProfileField,
  resolveInitialTimezone,
} from "../account-section-utils";

describe("describeRejectedProfileField", () => {
  const t = (key: string) => `translated:${key}`;

  it("resolves a known field path to its existing form label", () => {
    const label = describeRejectedProfileField(
      [{ path: "gender", code: "invalid_value" }],
      t,
    );
    expect(label).toBe("translated:settings.gender");
  });

  it("uses the first rejected field when several are present", () => {
    const label = describeRejectedProfileField(
      [
        { path: "heightCm", code: "too_small" },
        { path: "gender", code: "invalid_value" },
      ],
      t,
    );
    expect(label).toBe("translated:settings.height");
  });

  it("falls back to the raw path for a field this screen has no label for", () => {
    const label = describeRejectedProfileField(
      [{ path: "moodReminderEnabled", code: "invalid_type" }],
      t,
    );
    expect(label).toBe("moodReminderEnabled");
  });

  it("returns null for an empty or missing list", () => {
    expect(describeRejectedProfileField([], t)).toBeNull();
    expect(describeRejectedProfileField(undefined, t)).toBeNull();
  });

  // Regression guard for the underlying bug: this helper is the only
  // thing account-section renders after a rejection, so it must never
  // pass a raw Zod `message` (which could carry enum literal syntax)
  // straight through — only `path`, resolved to a pre-existing label.
  it("never echoes the issue's own `message`, even when one is present", () => {
    const label = describeRejectedProfileField(
      [
        {
          path: "gender",
          code: "invalid_value",
          message: 'Invalid option: expected one of "MALE"|"FEMALE"|"OTHER"',
        },
      ],
      t,
    );
    expect(label).not.toMatch(/expected one of/i);
    expect(label).toBe("translated:settings.gender");
  });
});

describe("resolveInitialTimezone", () => {
  it("keeps an explicitly stored non-default zone", () => {
    expect(resolveInitialTimezone("America/New_York", "Europe/Berlin")).toBe(
      "America/New_York",
    );
  });

  it("auto-seeds the browser zone when the stored value is still the default", () => {
    expect(resolveInitialTimezone("Europe/Berlin", "Asia/Tokyo")).toBe(
      "Asia/Tokyo",
    );
  });

  it("stays on the default when the browser zone is also the default", () => {
    expect(resolveInitialTimezone("Europe/Berlin", "Europe/Berlin")).toBe(
      "Europe/Berlin",
    );
  });

  it("falls back to the default when nothing is stored", () => {
    expect(resolveInitialTimezone(null, "Europe/Berlin")).toBe("Europe/Berlin");
  });
});
