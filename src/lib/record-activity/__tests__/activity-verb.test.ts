/**
 * The owner's ledger says what was done, not that something was.
 *
 * Mutation checks, run:
 *   - drop the `medications.intake.update` case → "each admitted verb has its
 *     own line" goes red on that action.
 *   - make the default arm throw instead of falling back → "an action this
 *     release has never heard of still renders" goes red.
 */
import { describe, expect, it } from "vitest";

import enMessages from "../../../../messages/en.json";
import { recordActivityVerbLine } from "../activity-verb";

/** Resolve a dotted key against the real EN bundle, params interpolated. */
function translate(
  key: string,
  params?: Record<string, string | number>,
): string {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      enMessages,
    );
  if (typeof value !== "string") throw new Error(`missing key: ${key}`);
  return Object.entries(params ?? {}).reduce(
    (text, [k, v]) => text.replaceAll(`{${k}}`, String(v)),
    value,
  );
}

/**
 * Every action the eleven admitted write verbs can file, with the audit
 * strings the handlers actually pass to `auditLog()`.
 */
const ADMITTED_ACTIONS = [
  "measurement.create",
  "labResult.create",
  "allergy.create",
  "family-history.create",
  "illness.episode.create",
  "biomarker.create",
  "customMetricEntry.create",
  "medication.sideEffect.create",
  "medication.create",
  "medications.intake.update",
] as const;

describe("recordActivityVerbLine", () => {
  it("each admitted verb has its own line", () => {
    const generic = translate("recordSharing.activity.acted", { name: "Anna" });
    const lines = ADMITTED_ACTIONS.map((action) =>
      recordActivityVerbLine(translate, action, "Anna"),
    );
    for (const line of lines) {
      // The point of the map: none of them may fall through to "made a
      // change", which is the line the owner already had.
      expect(line).not.toBe(generic);
      expect(line).toContain("Anna");
    }
    // And no two verbs share a line — a map that answered "added something"
    // ten times would pass the check above and say nothing.
    expect(new Set(lines).size).toBe(ADMITTED_ACTIONS.length);
  });

  it("an action this release has never heard of still renders", () => {
    // Audit rows outlive this map: a later release files verbs it does not
    // know, and older rows sit in the same table. Vague beats blank.
    expect(
      recordActivityVerbLine(translate, "future.thing.create", "Anna"),
    ).toBe(translate("recordSharing.activity.acted", { name: "Anna" }));
  });
});
