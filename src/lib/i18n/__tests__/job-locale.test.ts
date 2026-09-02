/**
 * `resolveJobLocale` — the locale a background path writes in.
 *
 * A job has no request to read a cookie or Accept-Language from, so the
 * stored `User.locale` is the only per-user signal. When it is NULL the
 * operator's configured default is the next best answer, and English only
 * when that is unset or invalid too. The old job-side coercions skipped the
 * middle step and wrote English for every account that had never touched
 * the language picker.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getOperatorDefaultLocale = vi.hoisted(() =>
  vi.fn<() => Promise<string | null>>(),
);

vi.mock("@/lib/app-settings", () => ({
  getOperatorDefaultLocale,
}));

import { resolveJobLocale } from "@/lib/i18n/job-locale";

beforeEach(() => {
  getOperatorDefaultLocale.mockReset();
  getOperatorDefaultLocale.mockResolvedValue(null);
});

describe("resolveJobLocale", () => {
  it("a valid stored user locale wins without consulting the operator default", async () => {
    getOperatorDefaultLocale.mockResolvedValue("de");
    await expect(resolveJobLocale("fr")).resolves.toBe("fr");
    expect(getOperatorDefaultLocale).not.toHaveBeenCalled();
  });

  it("a NULL user locale falls back to the operator default", async () => {
    getOperatorDefaultLocale.mockResolvedValue("de");
    await expect(resolveJobLocale(null)).resolves.toBe("de");
    await expect(resolveJobLocale(undefined)).resolves.toBe("de");
  });

  it("NULL user locale and no operator default resolve to English", async () => {
    getOperatorDefaultLocale.mockResolvedValue(null);
    await expect(resolveJobLocale(null)).resolves.toBe("en");
  });

  it("ignores invalid strings at both levels", async () => {
    getOperatorDefaultLocale.mockResolvedValue("xx");
    await expect(resolveJobLocale("zz-ZZ")).resolves.toBe("en");
    getOperatorDefaultLocale.mockResolvedValue("de");
    await expect(resolveJobLocale("")).resolves.toBe("de");
  });
});
