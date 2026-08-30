import { describe, it, expect } from "vitest";

import {
  ecgItemKey,
  healthScoreAlgorithmItemKey,
  healthScoreCompositionItemKey,
  milestoneItemKey,
  tensionWindowItemKey,
} from "@/lib/daily/priority-item-key";
import {
  isDismissibleItemKey,
  isScoreNoticeItemKey,
} from "@/lib/daily/priority-item";

describe("priority-item-key — deterministic dismiss identities", () => {
  it("milestoneItemKey folds kind + metric + reach day, namespaced `milestone:`", () => {
    const key = milestoneItemKey({
      kind: "record_first",
      metricType: "WEIGHT",
      sinceDate: "2026-07-16",
    });
    expect(key).toBe("milestone:record_first:WEIGHT:2026-07-16");
  });

  it("milestoneItemKey differs across metric types and reach days (never collides across instances)", () => {
    const a = milestoneItemKey({
      kind: "record_first",
      metricType: "WEIGHT",
      sinceDate: "2026-07-16",
    });
    const b = milestoneItemKey({
      kind: "record_first",
      metricType: "RESTING_HEART_RATE",
      sinceDate: "2026-07-16",
    });
    const c = milestoneItemKey({
      kind: "record_first",
      metricType: "WEIGHT",
      sinceDate: "2026-07-17",
    });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("ecgItemKey folds the recording's own ISO timestamp, namespaced `ecg_new_recording:`", () => {
    const recordedAt = new Date("2026-07-16T08:03:00.000Z");
    expect(ecgItemKey(recordedAt)).toBe(
      "ecg_new_recording:2026-07-16T08:03:00.000Z",
    );
  });

  it("tensionWindowItemKey folds the local day + part of day, namespaced `tension_window:`", () => {
    expect(tensionWindowItemKey("2026-07-16", "afternoon")).toBe(
      "tension_window:2026-07-16:afternoon",
    );
    // A different part of day on the same local day is a distinct instance.
    expect(tensionWindowItemKey("2026-07-16", "afternoon")).not.toBe(
      tensionWindowItemKey("2026-07-16", "evening"),
    );
  });

  it("every emitted key satisfies isDismissibleItemKey (prefix round-trips)", () => {
    expect(
      isDismissibleItemKey(
        milestoneItemKey({
          kind: "record_first",
          metricType: "WEIGHT",
          sinceDate: "2026-07-16",
        }),
      ),
    ).toBe(true);
    expect(
      isDismissibleItemKey(ecgItemKey(new Date("2026-07-16T08:00:00.000Z"))),
    ).toBe(true);
    expect(
      isDismissibleItemKey(tensionWindowItemKey("2026-07-16", "morning")),
    ).toBe(true);
  });

  it("isDismissibleItemKey rejects an actionable-shaped key", () => {
    expect(isDismissibleItemKey("dose_window:anything")).toBe(false);
    expect(isDismissibleItemKey("sync_issue:withings")).toBe(false);
    expect(isDismissibleItemKey("")).toBe(false);
  });

  it("healthScoreCompositionItemKey names the set, not the day", () => {
    const key = healthScoreCompositionItemKey(3, ["SLEEP", "BLOOD_PRESSURE"]);
    expect(key).toMatch(/^health-score:v3:composition:[0-9a-f]{12}$/);
    // Order in, same key out. The registry order the composite emits and the
    // order a stored row happens to hold must not be two identities for one
    // set, or the note would re-raise on a change that never happened.
    expect(healthScoreCompositionItemKey(3, ["BLOOD_PRESSURE", "SLEEP"])).toBe(
      key,
    );
    // A different set, and a different method, are both different notes.
    expect(healthScoreCompositionItemKey(3, ["SLEEP"])).not.toBe(key);
    expect(
      healthScoreCompositionItemKey(4, ["SLEEP", "BLOOD_PRESSURE"]),
    ).not.toBe(key);
  });

  it("the composition key dismisses and evicts, without widening what else does", () => {
    const composition = healthScoreCompositionItemKey(3, ["SLEEP"]);
    expect(isDismissibleItemKey(composition)).toBe(true);
    expect(isScoreNoticeItemKey(composition)).toBe(true);
    expect(isScoreNoticeItemKey(healthScoreAlgorithmItemKey(3))).toBe(true);
    // The eviction question is narrower than the dismissal question: an
    // observational rail item is dismissible and has nothing to do with the
    // score's cache.
    expect(
      isScoreNoticeItemKey(tensionWindowItemKey("2026-07-16", "morning")),
    ).toBe(false);
    expect(isScoreNoticeItemKey("dose_window:anything")).toBe(false);
  });
});
