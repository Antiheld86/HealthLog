import { describe, expect, it } from "vitest";

import {
  IN_USE_CLOCK_CONTAINER_TYPES,
  computeExpiresAt,
  computeInventoryState,
  hasInUseClock,
  type InventoryItemView,
} from "../state-machine";
import { MEDICATION_CONTAINER_TYPE_VALUES } from "@/lib/validations/medication/inventory";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-05-14T12:00:00Z");
const NOW_MS = NOW.getTime();

function makeItem(
  overrides: Partial<InventoryItemView> = {},
): InventoryItemView {
  return {
    state: "ACTIVE",
    containerType: "PEN",
    unitsTotal: 4,
    unitsRemaining: 4,
    firstUseAt: null,
    printedExpiry: null,
    ...overrides,
  };
}

describe("hasInUseClock", () => {
  it("covers every container kind the enum declares", () => {
    // A new enum member must be classified deliberately, not inherit a
    // default. This pins the full partition.
    const withClock = MEDICATION_CONTAINER_TYPE_VALUES.filter(hasInUseClock);
    const withoutClock = MEDICATION_CONTAINER_TYPE_VALUES.filter(
      (ct) => !hasInUseClock(ct),
    );
    expect(withClock).toEqual(["PEN", "AMPOULE"]);
    expect(withoutClock).toEqual(["BLISTER", "INHALER", "BOTTLE", "OTHER"]);
    expect([...IN_USE_CLOCK_CONTAINER_TYPES]).toEqual(withClock);
  });
});

describe("computeInventoryState", () => {
  it("returns ACTIVE for a fresh refrigerated pen", () => {
    expect(computeInventoryState(makeItem(), NOW_MS)).toBe("ACTIVE");
  });

  it("returns IN_USE once firstUseAt is set and within the 30-day window", () => {
    const item = makeItem({
      firstUseAt: new Date(NOW_MS - 5 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("IN_USE");
  });

  it("returns EXPIRED when the in-use clock blew past 30 days on a pen", () => {
    const item = makeItem({
      firstUseAt: new Date(NOW_MS - 31 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("EXPIRED");
  });

  it("returns EXPIRED when the in-use clock blew past 30 days on an ampoule", () => {
    const item = makeItem({
      containerType: "AMPOULE",
      firstUseAt: new Date(NOW_MS - 31 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("EXPIRED");
  });

  it("returns EXPIRED when printed expiry has lapsed (unopened pen)", () => {
    const item = makeItem({
      printedExpiry: new Date(NOW_MS - 1 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("EXPIRED");
  });

  it("returns EXPIRED when printed expiry has lapsed even if in-use clock still valid", () => {
    const item = makeItem({
      firstUseAt: new Date(NOW_MS - 5 * MS_PER_DAY),
      printedExpiry: new Date(NOW_MS - 1 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("EXPIRED");
  });

  it("returns USED_UP when unitsRemaining is zero (terminal — outranks EXPIRED)", () => {
    const item = makeItem({
      unitsRemaining: 0,
      firstUseAt: new Date(NOW_MS - 31 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("USED_UP");
  });

  it("returns USED_UP even when printed expiry has lapsed (unitsRemaining wins)", () => {
    const item = makeItem({
      unitsRemaining: 0,
      printedExpiry: new Date(NOW_MS - 5 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("USED_UP");
  });

  it("respects a custom in-use window override", () => {
    // Ozempic — 56 days per its EPAR.
    const item = makeItem({
      firstUseAt: new Date(NOW_MS - 45 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS, 56)).toBe("IN_USE");
    expect(computeInventoryState(item, NOW_MS, 30)).toBe("EXPIRED");
  });

  it("treats the exact 30-day boundary as still IN_USE", () => {
    const item = makeItem({
      firstUseAt: new Date(NOW_MS - 30 * MS_PER_DAY),
    });
    expect(computeInventoryState(item, NOW_MS)).toBe("IN_USE");
  });

  describe("containers without a post-opening clock", () => {
    // The reported defect: a blister of 54 tablets, no printed expiry,
    // opened well over 30 days ago. Pressing out the first tablet must
    // not write the other 53 off.
    it("keeps a long-opened blister with no printed expiry IN_USE", () => {
      const item = makeItem({
        containerType: "BLISTER",
        unitsTotal: 60,
        unitsRemaining: 54,
        firstUseAt: new Date(NOW_MS - 45 * MS_PER_DAY),
        printedExpiry: null,
      });
      expect(computeInventoryState(item, NOW_MS)).toBe("IN_USE");
    });

    // The counterpart the same fix must not weaken.
    it("still expires an opened pen past its window", () => {
      const item = makeItem({
        containerType: "PEN",
        unitsTotal: 60,
        unitsRemaining: 54,
        firstUseAt: new Date(NOW_MS - 45 * MS_PER_DAY),
        printedExpiry: null,
      });
      expect(computeInventoryState(item, NOW_MS)).toBe("EXPIRED");
    });

    it.each(["BLISTER", "INHALER", "BOTTLE", "OTHER"] as const)(
      "keeps a long-opened %s IN_USE",
      (containerType) => {
        const item = makeItem({
          containerType,
          firstUseAt: new Date(NOW_MS - 400 * MS_PER_DAY),
        });
        expect(computeInventoryState(item, NOW_MS)).toBe("IN_USE");
      },
    );

    it("still honours the printed expiry on a clock-less container", () => {
      const item = makeItem({
        containerType: "BLISTER",
        firstUseAt: new Date(NOW_MS - 45 * MS_PER_DAY),
        printedExpiry: new Date(NOW_MS - 1 * MS_PER_DAY),
      });
      expect(computeInventoryState(item, NOW_MS)).toBe("EXPIRED");
    });

    it("keeps a clock-less container ACTIVE while its printed expiry is ahead", () => {
      const item = makeItem({
        containerType: "BOTTLE",
        printedExpiry: new Date(NOW_MS + 200 * MS_PER_DAY),
      });
      expect(computeInventoryState(item, NOW_MS)).toBe("ACTIVE");
    });
  });
});

describe("computeExpiresAt", () => {
  it("returns null when neither firstUseAt nor printedExpiry is set", () => {
    expect(computeExpiresAt(null, null, "PEN")).toBeNull();
  });

  it("returns the printed expiry when only printedExpiry is set", () => {
    const printed = new Date("2027-01-15T00:00:00Z");
    expect(computeExpiresAt(null, printed, "PEN")).toEqual(printed);
  });

  it("returns firstUseAt + 30 days when only firstUseAt is set on a pen", () => {
    const firstUse = new Date("2026-05-01T00:00:00Z");
    const result = computeExpiresAt(firstUse, null, "PEN");
    expect(result?.getTime()).toBe(firstUse.getTime() + 30 * MS_PER_DAY);
  });

  it("returns the in-use deadline when it lands before printed expiry", () => {
    const firstUse = new Date("2026-05-01T00:00:00Z");
    const printed = new Date("2027-01-15T00:00:00Z");
    const result = computeExpiresAt(firstUse, printed, "PEN");
    expect(result?.getTime()).toBe(firstUse.getTime() + 30 * MS_PER_DAY);
  });

  it("returns the printed expiry when it lands before the in-use deadline", () => {
    const firstUse = new Date("2026-05-01T00:00:00Z");
    const printed = new Date("2026-05-10T00:00:00Z");
    const result = computeExpiresAt(firstUse, printed, "PEN");
    expect(result).toEqual(printed);
  });

  it("returns null for an opened blister with no printed expiry", () => {
    // Nothing for the daily expire-cron's indexed scan to find — which
    // is the point: there is no deadline to scan for.
    const firstUse = new Date("2026-05-01T00:00:00Z");
    expect(computeExpiresAt(firstUse, null, "BLISTER")).toBeNull();
  });

  it("returns the printed expiry alone for an opened blister that has one", () => {
    const firstUse = new Date("2026-05-01T00:00:00Z");
    const printed = new Date("2027-01-15T00:00:00Z");
    expect(computeExpiresAt(firstUse, printed, "BLISTER")).toEqual(printed);
  });
});
