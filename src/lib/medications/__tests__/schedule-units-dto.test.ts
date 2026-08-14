/**
 * #219 / iOS #25 — the per-schedule units wire shape.
 *
 * Watched red: with `resolvedUnitsPerDose` falling back to the raw value
 * alone (no medication-level inheritance) the NULL-slot case below fails —
 * the pre-v1.37.19 wire shipped only the raw nullable column and told the
 * client to derive the inheritance itself.
 */
import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";

import { serializeScheduleUnitsPerDose } from "../schedule-units-dto";

describe("serializeScheduleUnitsPerDose", () => {
  it("keeps the raw column and adds the server-resolved effective value", () => {
    const [explicit, inherited] = serializeScheduleUnitsPerDose(
      [
        { id: "s1", unitsPerDose: new Prisma.Decimal("0.5") },
        { id: "s2", unitsPerDose: null },
      ],
      new Prisma.Decimal("2"),
    );
    // Explicit slot: raw stays, resolved equals it.
    expect(explicit.unitsPerDose).toBe(0.5);
    expect(explicit.resolvedUnitsPerDose).toBe(0.5);
    // Inheriting slot: raw stays NULL (the edit surface needs the
    // distinction), resolved carries the medication level.
    expect(inherited.unitsPerDose).toBeNull();
    expect(inherited.resolvedUnitsPerDose).toBe(2);
  });

  it("serialises Decimals to plain JSON numbers", () => {
    const [row] = serializeScheduleUnitsPerDose(
      [{ unitsPerDose: new Prisma.Decimal("0.3333") }],
      1,
    );
    expect(typeof row.unitsPerDose).toBe("number");
    expect(typeof row.resolvedUnitsPerDose).toBe("number");
  });
});
