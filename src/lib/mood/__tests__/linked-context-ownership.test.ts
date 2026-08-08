/**
 * The linked block's gating, checked against the one ownership table.
 *
 * This file exists because the first draft of `linked-context.ts` hand-wrote
 * that map and got it wrong in both directions at once: it gated ambient steps
 * and active energy on `workouts`, which hides movement behind a toggle the
 * user never associated with it, and it declared resting heart rate and HRV
 * "core, no owner", which served the `recovery` domain to accounts that had
 * switched it off. Neither was catchable by any test that existed, because
 * both ends of the claim lived in the same file.
 *
 * So the claims are pinned to `moduleForMeasurementType()` — the table the MCP
 * wire, the correlations reader and the Coach snapshot all resolve through.
 * The resolver reads it at runtime, and these assertions say what it must keep
 * answering for the block shapes to stay honest.
 *
 * Mutation check: assign `ACTIVITY_STEPS` an owner in
 * `measurement-scope.ts` and the ambient row goes red; move
 * `HEART_RATE_VARIABILITY` to a different module from `RESTING_HEART_RATE` and
 * the shared-owner row goes red naming both.
 */
import { describe, expect, it } from "vitest";

import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";

describe("linked day context — module ownership", () => {
  it("keeps sleep owned by the sleep module", () => {
    expect(moduleForMeasurementType("SLEEP_DURATION")).toBe("sleep");
  });

  it("leaves ambient movement unowned, so the block is never gated", () => {
    // `workouts` gates workout SESSIONS. Steps and active energy are on the
    // ownership table's reviewed-unscoped list, and gating them here made the
    // mood sheet stricter than every other surface in the product.
    expect(moduleForMeasurementType("ACTIVITY_STEPS")).toBeNull();
    expect(moduleForMeasurementType("ACTIVE_ENERGY_BURNED")).toBeNull();
  });

  it("keeps both vitals owned by recovery, and by the SAME module", () => {
    const rhr = moduleForMeasurementType("RESTING_HEART_RATE");
    const hrv = moduleForMeasurementType("HEART_RATE_VARIABILITY");
    expect(rhr).toBe("recovery");
    expect(hrv).toBe("recovery");
    // The block carries one `available` flag for the pair, so the pair has to
    // answer to one module. The day they diverge, that single flag becomes a
    // lie about whichever of the two it does not describe, and the block has
    // to be split before the table is changed.
    expect(
      hrv,
      "the vitals block gates both figures on one module; these two no longer share an owner",
    ).toBe(rhr);
  });

  it("carries the HRV fallback in the same module as the primary type", () => {
    // A ring-only account resolves HRV to its RMSSD fallback. Left unowned,
    // the fallback would serve exactly the recovery data the primary type
    // refuses.
    expect(moduleForMeasurementType("HRV_RMSSD")).toBe(
      moduleForMeasurementType("HEART_RATE_VARIABILITY"),
    );
  });
});
