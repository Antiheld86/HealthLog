/**
 * v1.4.25 W7 — resolver tests.
 *
 * The cache-hit / cache-miss assertions assume the test file is run
 * in isolation. Vitest's default per-file isolation gives us that.
 * Each test imports the module fresh, so the module-level caches
 * don't leak across cases.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock prisma BEFORE importing the resolver.
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    appSettings: { findUnique: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import {
  DEFAULT_TIMEZONE,
  detectBrowserTimezone,
  formatInUserTz,
  invalidateServerDefaultTimezone,
  invalidateUserTimezone,
  hourInTz,
  isNearUtc,
  isValidTimezone,
  resolveServerDefaultTimezone,
  resolveUserTimezone,
  userDayKey,
} from "../resolver";

beforeEach(() => {
  vi.clearAllMocks();
  invalidateUserTimezone("user-1");
  invalidateUserTimezone("user-2");
  invalidateServerDefaultTimezone();
});

describe("isValidTimezone", () => {
  it("accepts canonical IANA zones", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Pacific/Auckland")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });

  it("rejects obvious nonsense", () => {
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("Not/A_Zone")).toBe(false);
    expect(isValidTimezone("Europe/Berlin' OR 1=1")).toBe(false);
  });

  it("rejects strings longer than 64 chars", () => {
    expect(isValidTimezone("A".repeat(65))).toBe(false);
  });

  // The runtime accepts UTC offsets as zone ids, but Postgres reads a bare
  // offset in `AT TIME ZONE` with the POSIX sign (east is negative), so a day
  // cut in SQL would land on the wrong side of UTC.
  it("rejects bare UTC offsets", () => {
    expect(isValidTimezone("+05:30")).toBe(false);
    expect(isValidTimezone("-0800")).toBe(false);
    expect(isValidTimezone("+05")).toBe(false);
    expect(isValidTimezone("\u221205:00")).toBe(false);
  });

  it("keeps accepting named zones, aliases and the Etc family", () => {
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
    expect(isValidTimezone("Asia/Calcutta")).toBe(true);
    expect(isValidTimezone("Europe/Kyiv")).toBe(true);
    expect(isValidTimezone("Etc/UTC")).toBe(true);
    expect(isValidTimezone("Etc/GMT+5")).toBe(true);
  });
});

describe("resolveServerDefaultTimezone", () => {
  it("returns Europe/Berlin when AppSettings is empty", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    expect(await resolveServerDefaultTimezone()).toBe("Europe/Berlin");
  });

  it("returns the configured value when set", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      defaultUserTimezone: "Asia/Tokyo",
    } as never);
    expect(await resolveServerDefaultTimezone()).toBe("Asia/Tokyo");
  });

  it("falls back when the configured value is invalid", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      defaultUserTimezone: "Mars/Olympus_Mons",
    } as never);
    expect(await resolveServerDefaultTimezone()).toBe("Europe/Berlin");
  });

  it("hits the cache on the second call", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      defaultUserTimezone: "Asia/Tokyo",
    } as never);
    await resolveServerDefaultTimezone();
    await resolveServerDefaultTimezone();
    await resolveServerDefaultTimezone();
    expect(prisma.appSettings.findUnique).toHaveBeenCalledTimes(1);
  });

  it("re-reads after invalidation", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      defaultUserTimezone: "Asia/Tokyo",
    } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      defaultUserTimezone: "America/New_York",
    } as never);

    expect(await resolveServerDefaultTimezone()).toBe("Asia/Tokyo");
    invalidateServerDefaultTimezone();
    expect(await resolveServerDefaultTimezone()).toBe("America/New_York");
  });
});

describe("resolveUserTimezone", () => {
  it("returns User.timezone when present", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      timezone: "Pacific/Auckland",
    } as never);
    expect(await resolveUserTimezone("user-1")).toBe("Pacific/Auckland");
  });

  it("falls back to the server default for a stored bare offset", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      timezone: "+05:30",
    } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      defaultUserTimezone: "Asia/Tokyo",
    } as never);
    expect(await resolveUserTimezone("user-1")).toBe("Asia/Tokyo");
  });

  it("falls back to the server default when the user row is missing", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      defaultUserTimezone: "Asia/Tokyo",
    } as never);
    expect(await resolveUserTimezone("user-1")).toBe("Asia/Tokyo");
  });

  it("falls back to Europe/Berlin when neither user nor server default exist", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    expect(await resolveUserTimezone("user-1")).toBe("Europe/Berlin");
  });

  it("hits the cache on the second call", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      timezone: "Pacific/Auckland",
    } as never);
    await resolveUserTimezone("user-1");
    await resolveUserTimezone("user-1");
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it("re-reads after invalidation", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      timezone: "Pacific/Auckland",
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      timezone: "America/New_York",
    } as never);

    expect(await resolveUserTimezone("user-1")).toBe("Pacific/Auckland");
    invalidateUserTimezone("user-1");
    expect(await resolveUserTimezone("user-1")).toBe("America/New_York");
  });

  it("caches per-userId so two users do not collide", async () => {
    // Two distinct findUnique calls; we use mockResolvedValueOnce
    // queued ahead of time. The cache hit on the third call
    // bypasses the mock altogether.
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      timezone: "Pacific/Auckland",
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      timezone: "America/New_York",
    } as never);

    expect(await resolveUserTimezone("user-1")).toBe("Pacific/Auckland");
    expect(await resolveUserTimezone("user-2")).toBe("America/New_York");
    expect(await resolveUserTimezone("user-1")).toBe("Pacific/Auckland");
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it("returns the server default for empty userId", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    expect(await resolveUserTimezone("")).toBe("Europe/Berlin");
  });
});

describe("detectBrowserTimezone", () => {
  it("returns a non-empty string", () => {
    expect(detectBrowserTimezone().length).toBeGreaterThan(0);
  });
});

describe("formatInUserTz", () => {
  // 2026-05-11T09:05:00Z — a Monday morning in May (CEST in Berlin,
  // NZST in Auckland is UTC+12 in May with DST off).
  const instant = new Date("2026-05-11T09:05:00.000Z");

  it("emits ISO-8601 with offset for Europe/Berlin (CEST in May)", () => {
    expect(formatInUserTz(instant, "Europe/Berlin", "iso-with-offset")).toBe(
      "2026-05-11T11:05:00+02:00",
    );
  });

  it("emits ISO-8601 with offset for Pacific/Auckland (NZST in May)", () => {
    // May 2026 = NZST = UTC+12 (DST ends in early April for NZ).
    expect(formatInUserTz(instant, "Pacific/Auckland", "iso-with-offset")).toBe(
      "2026-05-11T21:05:00+12:00",
    );
  });

  it("emits ISO-8601 with offset for America/New_York (EDT in May)", () => {
    // May = EDT = UTC-04:00.
    expect(formatInUserTz(instant, "America/New_York", "iso-with-offset")).toBe(
      "2026-05-11T05:05:00-04:00",
    );
  });

  it("emits ISO-8601 for UTC with +00:00", () => {
    expect(formatInUserTz(instant, "UTC", "iso-with-offset")).toBe(
      "2026-05-11T09:05:00+00:00",
    );
  });

  it("falls back to Europe/Berlin when handed an invalid tz", () => {
    expect(formatInUserTz(instant, "Mars/Olympus", "iso-with-offset")).toBe(
      "2026-05-11T11:05:00+02:00",
    );
  });

  it("formats wall-clock without timezone marker", () => {
    expect(formatInUserTz(instant, "Pacific/Auckland", "wall-clock")).toBe(
      "21:05",
    );
  });

  it("formats datetime as YYYY-MM-DD HH:MM", () => {
    expect(formatInUserTz(instant, "Pacific/Auckland", "datetime")).toBe(
      "2026-05-11 21:05",
    );
  });

  it("formats date-only as YYYY-MM-DD", () => {
    expect(formatInUserTz(instant, "Pacific/Auckland", "date")).toBe(
      "2026-05-11",
    );
  });

  it("round-trips Berlin vs Auckland — same instant, different days", () => {
    // 2026-05-10T22:30:00Z — 23 May in Auckland already, still 10 May
    // in Berlin (00:30 next day actually, so 11 May Berlin).
    // Pick a clearer case: 12:30 UTC = 14:30 Berlin = 00:30 Auckland (next day).
    const lateNight = new Date("2026-05-10T12:30:00.000Z");
    expect(formatInUserTz(lateNight, "Europe/Berlin", "date")).toBe(
      "2026-05-10",
    );
    expect(formatInUserTz(lateNight, "Pacific/Auckland", "date")).toBe(
      "2026-05-11",
    );
  });

  it("honours DST: Berlin in January is CET = +01:00", () => {
    const jan = new Date("2026-01-15T09:05:00.000Z");
    expect(formatInUserTz(jan, "Europe/Berlin", "iso-with-offset")).toBe(
      "2026-01-15T10:05:00+01:00",
    );
  });
});

describe("userDayKey", () => {
  it("matches the Berlin reference when tz=Europe/Berlin", () => {
    const instant = new Date("2025-10-25T21:30:00Z"); // Sat 23:30 Berlin
    expect(userDayKey(instant, "Europe/Berlin")).toBe("2025-10-25");
  });

  it("returns the next day when the user is east of UTC by enough", () => {
    const instant = new Date("2026-05-10T14:50:00Z"); // 23:50 Tokyo
    expect(userDayKey(instant, "Asia/Tokyo")).toBe("2026-05-10");
    expect(userDayKey(instant, "Pacific/Auckland")).toBe("2026-05-11");
  });
});

describe("hourInTz", () => {
  it("reads the wall-clock hour in the user's zone, not UTC", () => {
    // 2026-06-15T03:00Z is 20:00 the previous day in Los Angeles (UTC-7),
    // 05:00 in Berlin (UTC+2), 12:00 in Tokyo (UTC+9).
    const instant = new Date("2026-06-15T03:00:00.000Z");
    expect(hourInTz(instant, "UTC")).toBe(3);
    expect(hourInTz(instant, "America/Los_Angeles")).toBe(20);
    expect(hourInTz(instant, "Europe/Berlin")).toBe(5);
    expect(hourInTz(instant, "Asia/Tokyo")).toBe(12);
  });

  it("normalises local midnight to 0, never 24", () => {
    const instant = new Date("2026-06-14T22:00:00.000Z"); // 00:00 Berlin
    expect(hourInTz(instant, "Europe/Berlin")).toBe(0);
  });

  it("falls back to the default zone for an unusable tz string", () => {
    // Mirrors formatInUserTz / userDayKey: an invalid zone degrades to
    // DEFAULT_TIMEZONE (Europe/Berlin), which is UTC+2 in summer.
    const instant = new Date("2026-06-15T09:00:00.000Z");
    expect(hourInTz(instant, "Mars/Olympus")).toBe(11);
  });
});

describe("isNearUtc", () => {
  // Pin a summer-side instant so DST is on for Berlin (+2) and off for
  // most southern-hemisphere zones — keeps the assertions readable.
  const summer = new Date("2026-07-15T12:00:00.000Z");
  // Winter-side instant so Berlin is on CET (+1).
  const winter = new Date("2026-01-15T12:00:00.000Z");

  it("returns true for UTC", () => {
    expect(isNearUtc("UTC", summer)).toBe(true);
  });

  it("returns true for Europe/Berlin in both summer and winter", () => {
    expect(isNearUtc("Europe/Berlin", summer)).toBe(true);
    expect(isNearUtc("Europe/Berlin", winter)).toBe(true);
  });

  it("returns true for the ±3h boundary zones", () => {
    // Europe/Moscow = +3 year-round.
    expect(isNearUtc("Europe/Moscow", summer)).toBe(true);
    // Atlantic/Azores = -1 in winter, 0 in summer.
    expect(isNearUtc("Atlantic/Azores", summer)).toBe(true);
  });

  it("returns false for zones more than 3 hours from UTC", () => {
    // Pacific/Honolulu = -10 year-round.
    expect(isNearUtc("Pacific/Honolulu", summer)).toBe(false);
    // Asia/Tokyo = +9 year-round.
    expect(isNearUtc("Asia/Tokyo", summer)).toBe(false);
    // America/New_York = -4 in summer, -5 in winter.
    expect(isNearUtc("America/New_York", summer)).toBe(false);
    // Pacific/Auckland = +13 in southern summer (Jan), +12 in May.
    expect(isNearUtc("Pacific/Auckland", winter)).toBe(false);
  });

  it("defaults to near-UTC when the zone string is invalid", () => {
    // Invalid zones fall back to Europe/Berlin, which is near-UTC.
    expect(isNearUtc("Mars/Olympus_Mons", summer)).toBe(true);
  });

  it("uses the current instant when `now` is omitted", () => {
    // Pure smoke — exercises the default parameter branch.
    expect(typeof isNearUtc("Europe/Berlin")).toBe("boolean");
  });
});

describe("DEFAULT_TIMEZONE", () => {
  it("is Europe/Berlin", () => {
    expect(DEFAULT_TIMEZONE).toBe("Europe/Berlin");
  });
});

describe("request schemas refuse a bare offset zone", () => {
  it("the screener submission", async () => {
    const { createAssessmentSchema } =
      await import("@/lib/validations/mental-health");
    const base = { instrument: "PHQ9", items: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
    expect(
      createAssessmentSchema.safeParse({ ...base, tz: "Asia/Kolkata" }).success,
    ).toBe(true);
    expect(
      createAssessmentSchema.safeParse({ ...base, tz: "+05:30" }).success,
    ).toBe(false);
  });
});
