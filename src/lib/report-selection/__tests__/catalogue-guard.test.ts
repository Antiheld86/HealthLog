/**
 * The catalogue's own invariants — the ones the compiler cannot state.
 *
 * The two `Record` types already force a group decision for every measurement
 * type and every structured leaf. What they cannot force is that each leaf has
 * a label a human can read, that the label resolves in the shipped bundle, and
 * that the fenced tier stays last. A leaf with no label renders as a raw enum
 * string on a clinical document.
 *
 * Mutation checks:
 *   - drop `PAIN_NRS` from `MEASUREMENT_LEAF_GROUP` → typecheck fails first,
 *     and with the type widened the count assertion goes red.
 *   - point `STRUCTURED_LEAF_LABEL_KEYS.MOOD` at a key that is not in the
 *     bundle → "resolves a label for every leaf" goes red naming MOOD.
 *   - move `"sensitive"` out of last place in `REPORT_GROUP_ORDER` → the order
 *     assertion goes red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ALL_LEAF_IDS,
  MEASUREMENT_LEAF_IDS,
  REPORT_GROUPS,
  REPORT_GROUP_LABEL_KEYS,
  REPORT_GROUP_ORDER,
  SENSITIVE_LEAF_IDS,
  STRUCTURED_LEAF_IDS,
  leafLabelKey,
} from "../catalogue";
import { STANDARD_TEMPLATE_LEAVES } from "../template";

const EN = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "..", "..", "messages", "en.json"),
    "utf8",
  ),
) as Record<string, unknown>;

function resolves(key: string): boolean {
  let node: unknown = EN;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" && node.length > 0;
}

describe("report selection catalogue", () => {
  it("carries every measurement type and every structured leaf", () => {
    expect(MEASUREMENT_LEAF_IDS).toHaveLength(77);
    expect(STRUCTURED_LEAF_IDS).toHaveLength(13);
    expect(ALL_LEAF_IDS).toHaveLength(90);
  });

  it("resolves a label for every leaf", () => {
    const unlabelled = ALL_LEAF_IDS.filter(
      (leaf) => !resolves(leafLabelKey(leaf)),
    );
    expect(
      unlabelled,
      "these leaves have no label in messages/en.json and would render as a " +
        "raw enum string on a clinical document",
    ).toEqual([]);
  });

  it("resolves a label for every group", () => {
    const unlabelled = REPORT_GROUP_ORDER.filter(
      (group) => !resolves(REPORT_GROUP_LABEL_KEYS[group]),
    );
    expect(unlabelled).toEqual([]);
  });

  it("orders the groups the way the panel and the PDF read them", () => {
    expect(REPORT_GROUPS.map((g) => g.id)).toEqual([...REPORT_GROUP_ORDER]);
    // The fenced tier is last, so it sits below every group control rather
    // than among them.
    expect(REPORT_GROUP_ORDER[REPORT_GROUP_ORDER.length - 1]).toBe("sensitive");
  });
});

describe("template purity", () => {
  it("keeps the shipped template clear of the fenced tier", () => {
    const overlap = STANDARD_TEMPLATE_LEAVES.filter((leaf) =>
      SENSITIVE_LEAF_IDS.includes(leaf),
    );
    expect(
      overlap,
      "the shipped template must never preselect a fenced leaf",
    ).toEqual([]);
  });

  it("names every template leaf in the catalogue", () => {
    const unknown = STANDARD_TEMPLATE_LEAVES.filter(
      (leaf) => !ALL_LEAF_IDS.includes(leaf),
    );
    expect(unknown).toEqual([]);
  });

  it("fences exactly the seven leaves the design names", () => {
    expect([...SENSITIVE_LEAF_IDS].sort()).toEqual(
      [
        "CYCLE",
        "FAMILY_HISTORY",
        "GAD7_SCORE",
        "MOOD",
        "PHQ9_SCORE",
        "SCI_SCORE",
        "WHO5_SCORE",
      ].sort(),
    );
  });
});
