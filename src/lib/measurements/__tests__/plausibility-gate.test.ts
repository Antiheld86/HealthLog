/**
 * The ingest-side plausibility gate.
 *
 * `VALUE_RANGES` is the band the application declares a metric can occupy, and
 * every path a person can drive has always enforced it. The provider sync
 * writers did not, which is how a row the application itself calls impossible
 * reached the table and poisoned every mean and personal band derived from it.
 * These cases pin the two halves of the fix: the refusal, and the fact that a
 * refusal is never silent.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { WideEventBuilder } from "@/lib/logging/event-builder";
import { eventStorage } from "@/lib/logging/context";
import {
  RANGE_REJECTED_META_KEY,
  classifyRangeRejection,
  dropImplausibleMeasurements,
  recordRangeRejections,
  type RangeRejectionTally,
} from "../plausibility-gate";

let event: WideEventBuilder;

function withEvent<T>(run: () => T): T {
  return eventStorage.run(event, run);
}

function tally(): RangeRejectionTally | undefined {
  return event.toJSON().meta?.[RANGE_REJECTED_META_KEY] as
    RangeRejectionTally | undefined;
}

beforeEach(() => {
  event = new WideEventBuilder("background");
});

describe("classifyRangeRejection", () => {
  it("passes a value inside the metric's declared band", () => {
    // PULSE is declared 20–300; both edges are inclusive.
    expect(classifyRangeRejection("PULSE", 60)).toBeNull();
    expect(classifyRangeRejection("PULSE", 20)).toBeNull();
    expect(classifyRangeRejection("PULSE", 300)).toBeNull();
  });

  it("names the edge an out-of-band value broke", () => {
    expect(classifyRangeRejection("PULSE", 55643821.505)).toEqual({
      type: "PULSE",
      direction: "above_max",
    });
    expect(classifyRangeRejection("PULSE", 19)).toEqual({
      type: "PULSE",
      direction: "below_min",
    });
  });

  it("refuses a non-finite value whatever the metric", () => {
    expect(classifyRangeRejection("PULSE", Number.NaN)).toEqual({
      type: "PULSE",
      direction: "not_finite",
    });
    // No declared band, so the value itself is the only thing to judge.
    expect(
      classifyRangeRejection("NOT_A_METRIC", Number.POSITIVE_INFINITY),
    ).toEqual({ type: "NOT_A_METRIC", direction: "not_finite" });
  });

  it("passes a metric with no declared band — an absent range is an absent fact", () => {
    expect(classifyRangeRejection("NOT_A_METRIC", 9_999_999)).toBeNull();
  });
});

describe("dropImplausibleMeasurements", () => {
  it("keeps the in-band rows and returns them untouched", () => {
    const rows = [
      { type: "PULSE", value: 60 },
      { type: "WEIGHT", value: 82.4 },
    ];
    const kept = withEvent(() =>
      dropImplausibleMeasurements("withings", rows, (r) => r),
    );

    expect(kept).toEqual(rows);
    expect(kept[0]).toBe(rows[0]);
    // Nothing was refused, so the event carries no tally at all — absence
    // reads as absence.
    expect(tally()).toBeUndefined();
    expect(event.toJSON().warnings).toBeUndefined();
  });

  it("drops the out-of-band rows and tallies them on the wide event", () => {
    const kept = withEvent(() =>
      dropImplausibleMeasurements(
        "withings",
        [
          { type: "PULSE", value: 60 },
          { type: "PULSE", value: 55643821.505 },
          { type: "PULSE", value: 900 },
          { type: "WEIGHT", value: 0.2 },
        ],
        (r) => r,
      ),
    );

    expect(kept).toEqual([{ type: "PULSE", value: 60 }]);

    const recorded = tally();
    expect(recorded).toEqual({
      total: 3,
      buckets: [
        {
          source: "withings",
          type: "PULSE",
          direction: "above_max",
          count: 2,
        },
        {
          source: "withings",
          type: "WEIGHT",
          direction: "below_min",
          count: 1,
        },
      ],
    });
  });

  it("keeps the refused readings out of the log line", () => {
    withEvent(() =>
      dropImplausibleMeasurements(
        "withings",
        [{ type: "PULSE", value: 55643821.505 }],
        (r) => r,
      ),
    );

    // The value is a health reading. The tally says which metric, which
    // provider and which edge — never the number itself.
    const serialised = JSON.stringify(event.toJSON());
    expect(serialised).not.toContain("55643821");
  });

  it("lifts the event to warn once per provider", () => {
    withEvent(() => {
      dropImplausibleMeasurements(
        "withings",
        [{ type: "PULSE", value: 900 }],
        (r) => r,
      );
      dropImplausibleMeasurements(
        "withings",
        [{ type: "PULSE", value: 901 }],
        (r) => r,
      );
      dropImplausibleMeasurements(
        "fitbit",
        [{ type: "PULSE", value: 902 }],
        (r) => r,
      );
    });

    expect(event.getLevel()).toBe("warn");
    expect(event.toJSON().warnings).toHaveLength(2);
    expect(event.toJSON().warnings?.[0]).toContain("withings");
    expect(event.toJSON().warnings?.[1]).toContain("fitbit");
  });

  it("accumulates across calls instead of overwriting the previous tally", () => {
    // Fitbit gates once per resource leg, and the reconciler gates once per
    // row: a tally that replaced rather than merged would report only the
    // last batch, and a run that dropped hundreds would read as dropping one.
    withEvent(() => {
      dropImplausibleMeasurements(
        "fitbit",
        [{ type: "PULSE", value: 900 }],
        (r) => r,
      );
      dropImplausibleMeasurements(
        "fitbit",
        [
          { type: "PULSE", value: 901 },
          { type: "OXYGEN_SATURATION", value: 4 },
        ],
        (r) => r,
      );
    });

    expect(tally()).toEqual({
      total: 3,
      buckets: [
        {
          source: "fitbit",
          type: "OXYGEN_SATURATION",
          direction: "below_min",
          count: 1,
        },
        { source: "fitbit", type: "PULSE", direction: "above_max", count: 2 },
      ],
    });
  });

  it("still drops outside a wide-event context", () => {
    // A sync running without an ambient event has nowhere to report. The row
    // is refused anyway: observability is what is lost, never the guarantee.
    const kept = dropImplausibleMeasurements(
      "nightscout",
      [
        { type: "BLOOD_GLUCOSE", value: 110 },
        { type: "BLOOD_GLUCOSE", value: 9_000 },
      ],
      (r) => r,
    );
    expect(kept).toEqual([{ type: "BLOOD_GLUCOSE", value: 110 }]);
  });
});

describe("recordRangeRejections", () => {
  it("writes nothing when there is nothing to report", () => {
    withEvent(() => recordRangeRejections("withings", []));
    expect(tally()).toBeUndefined();
    expect(event.getLevel()).toBe("info");
  });
});
