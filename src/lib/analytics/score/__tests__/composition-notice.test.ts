/**
 * When a pillar leaving is worth a sentence, and when it is noise.
 *
 * The decision is the whole feature. Rendering a note nobody needed is the
 * failure this repo calls nagging, and staying silent on the one change
 * nobody chose is the defect the note exists to close, so both arms are
 * asserted here rather than only the raising one.
 *
 * Pure values throughout — the reader's query and the dismissal lookup are
 * proved against real Postgres in `tests/integration/health-score-record.ts`,
 * where a stored row is a stored row rather than a fixture agreeing with the
 * code that made it.
 */
import { describe, expect, it } from "vitest";

import {
  buildCompositionNotice,
  compositionNoticeKey,
  type CompositionNoticeInput,
} from "@/lib/analytics/score/composition-notice";
import { healthScoreCompositionItemKey } from "@/lib/daily/priority-item-key";
import type { ScorePillarId } from "@/lib/analytics/score/types";

const YESTERDAY = ["BLOOD_PRESSURE", "SLEEP", "ADIPOSITY"];

function input(over: Partial<CompositionNoticeInput> = {}) {
  return {
    current: ["BLOOD_PRESSURE", "SLEEP", "ADIPOSITY"] as ScorePillarId[],
    previous: {
      composition: YESTERDAY,
      scoreVersion: 3,
      configVersion: 0,
    },
    scoreVersion: 3,
    configVersion: 0,
    ...over,
  } satisfies CompositionNoticeInput;
}

describe("the composition note only speaks when the set actually moved", () => {
  it("says nothing while the set is the same", () => {
    expect(compositionNoticeKey(input())).toBeNull();
  });

  it("says nothing when registry order is the only difference", () => {
    expect(
      compositionNoticeKey(
        input({
          previous: {
            composition: ["ADIPOSITY", "SLEEP", "BLOOD_PRESSURE"],
            scoreVersion: 3,
            configVersion: 0,
          },
        }),
      ),
    ).toBeNull();
  });

  it("says nothing on a first-ever scored day", () => {
    expect(compositionNoticeKey(input({ previous: null }))).toBeNull();
  });

  it("says nothing when there is no score to explain", () => {
    expect(compositionNoticeKey(input({ current: [] }))).toBeNull();
  });

  it("raises a key when a pillar drops out on its own", () => {
    const decision = input({
      current: ["BLOOD_PRESSURE", "ADIPOSITY"] as ScorePillarId[],
    });
    const key = compositionNoticeKey(decision);
    expect(key).toBe(
      healthScoreCompositionItemKey(3, ["BLOOD_PRESSURE", "ADIPOSITY"]),
    );
    expect(buildCompositionNotice(decision, key!, false)).toEqual({
      itemKey: key,
      left: ["SLEEP"],
      joined: [],
      dismissed: false,
    });
  });

  it("names both directions when one pillar leaves and another arrives", () => {
    const decision = input({
      current: ["BLOOD_PRESSURE", "ADIPOSITY", "LIPIDS"] as ScorePillarId[],
    });
    const key = compositionNoticeKey(decision)!;
    const notice = buildCompositionNotice(decision, key, false);
    expect(notice.left).toEqual(["SLEEP"]);
    expect(notice.joined).toEqual(["LIPIDS"]);
  });

  it("keys on the resulting set, so an unchanged set tomorrow keeps the dismissal", () => {
    // Day one: sleep leaves. Day two: the same narrower set stands, and the
    // key resolves to the same string, so a dismissal on day one still
    // matches. Re-keying per day is what would make a dismissible note
    // reappear every morning, which is the nagging shape.
    const dropped = ["BLOOD_PRESSURE", "ADIPOSITY"] as ScorePillarId[];
    const first = compositionNoticeKey(input({ current: dropped }))!;
    const second = compositionNoticeKey(
      input({
        current: dropped,
        previous: {
          composition: [...YESTERDAY],
          scoreVersion: 3,
          configVersion: 0,
        },
      }),
    );
    expect(second).toBe(first);
  });

  it("stays silent when the method moved — that note is already raised", () => {
    expect(
      compositionNoticeKey(
        input({
          current: ["BLOOD_PRESSURE", "ADIPOSITY"] as ScorePillarId[],
          previous: {
            composition: YESTERDAY,
            scoreVersion: 2,
            configVersion: 0,
          },
        }),
      ),
    ).toBeNull();
  });

  it("stays silent when the person changed their own recipe", () => {
    expect(
      compositionNoticeKey(
        input({
          current: ["BLOOD_PRESSURE", "ADIPOSITY"] as ScorePillarId[],
          configVersion: 2,
          previous: {
            composition: YESTERDAY,
            scoreVersion: 3,
            configVersion: 1,
          },
        }),
      ),
    ).toBeNull();
  });

  it("still speaks for a row written before the recipe columns existed", () => {
    // `configVersion` is nullable only because the columns predate the
    // writer by one release. A null there is "unknown", and treating an
    // unknown as a recipe change would silence the note for every account
    // carrying one of those rows.
    expect(
      compositionNoticeKey(
        input({
          current: ["BLOOD_PRESSURE", "ADIPOSITY"] as ScorePillarId[],
          configVersion: 4,
          previous: {
            composition: YESTERDAY,
            scoreVersion: 3,
            configVersion: null,
          },
        }),
      ),
    ).not.toBeNull();
  });

  it("treats a retired pillar id on a stored row as the absence it now is", () => {
    // A row naming FITNESS predates the catalogue that dropped it. Comparing
    // raw strings would report a change every single day, forever.
    expect(
      compositionNoticeKey(
        input({
          previous: {
            composition: [...YESTERDAY, "FITNESS"],
            scoreVersion: 3,
            configVersion: 0,
          },
        }),
      ),
    ).toBeNull();
  });
});
