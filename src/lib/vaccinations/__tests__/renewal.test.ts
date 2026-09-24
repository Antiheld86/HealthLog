import { describe, expect, it } from "vitest";

import {
  VACCINATION_RENEWAL_SOON_DAYS,
  resolveRenewals,
} from "@/lib/vaccinations/renewal";

const NOW = new Date("2026-09-24T10:00:00.000Z");
const TZ = "Europe/Berlin";

function reminder(
  over: Partial<{
    id: string;
    vaccinationAntigen: string | null;
    nextDueAt: Date | null;
    enabled: boolean;
  }> = {},
) {
  return {
    id: "rem-1",
    vaccinationAntigen: "tetanus",
    nextDueAt: new Date("2030-01-01T08:00:00.000Z"),
    enabled: true,
    ...over,
  };
}

describe("resolveRenewals", () => {
  it("reads a booster far off as current", () => {
    expect(resolveRenewals([reminder()], NOW, TZ)).toEqual([
      {
        antigen: "tetanus",
        reminderId: "rem-1",
        dueAt: "2030-01-01T08:00:00.000Z",
        daysUntil: expect.any(Number),
        state: "current",
      },
    ]);
  });

  it("reads a booster inside the soon window as due soon, edges included", () => {
    const soon = new Date(
      NOW.getTime() + VACCINATION_RENEWAL_SOON_DAYS * 24 * 60 * 60 * 1000,
    );
    const [renewal] = resolveRenewals([reminder({ nextDueAt: soon })], NOW, TZ);
    expect(renewal!.daysUntil).toBe(VACCINATION_RENEWAL_SOON_DAYS);
    expect(renewal!.state).toBe("dueSoon");
    const [today] = resolveRenewals([reminder({ nextDueAt: NOW })], NOW, TZ);
    expect(today!.state).toBe("dueSoon");
  });

  it("reads a booster whose date has passed as overdue", () => {
    const [renewal] = resolveRenewals(
      [reminder({ nextDueAt: new Date("2026-09-01T08:00:00.000Z") })],
      NOW,
      TZ,
    );
    expect(renewal!.state).toBe("overdue");
    expect(renewal!.daysUntil).toBeLessThan(0);
  });

  it("ignores a switched-off reminder, one with no antigen, and one with no date", () => {
    expect(
      resolveRenewals(
        [
          reminder({ enabled: false }),
          reminder({ vaccinationAntigen: null }),
          reminder({ nextDueAt: null }),
        ],
        NOW,
        TZ,
      ),
    ).toEqual([]);
  });

  it("answers one renewal per antigen, the earliest due", () => {
    const renewals = resolveRenewals(
      [
        reminder({ id: "late", nextDueAt: new Date("2031-01-01T08:00:00Z") }),
        reminder({ id: "early", nextDueAt: new Date("2029-01-01T08:00:00Z") }),
        reminder({
          id: "flu",
          vaccinationAntigen: "influenza",
          nextDueAt: new Date("2026-10-01T08:00:00Z"),
        }),
      ],
      NOW,
      TZ,
    );
    expect(renewals.map((r) => [r.antigen, r.reminderId])).toEqual([
      ["influenza", "flu"],
      ["tetanus", "early"],
    ]);
  });
});
