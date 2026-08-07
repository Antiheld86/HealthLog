/**
 * The banner names which KIND of record this is, and the two names differ.
 *
 * ## Why this file exists
 *
 * `recordKindLabel` is a two-arm ternary, and until this file nothing could
 * fail it. The browser journey asserted `data-record-kind="managed"` — an
 * attribute the function does not read — so inverting the arms left the whole
 * suite green while the banner told a Guardian standing inside a managed
 * profile that they were in an ordinary shared record. That is not a cosmetic
 * difference: the two records have different rules, and the banner is the one
 * line of chrome whose job is to say which one you are in.
 *
 * The mapping is asserted through the real EN bundle rather than against key
 * names, because a key that resolves to the wrong sentence passes a key-level
 * check. Both arms are named, and the two are asserted to be DIFFERENT — a
 * function that returned one sentence for both would satisfy every "contains"
 * assertion anybody would think to write.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { recordKindLabel } from "../shared-record-banner";

/** The real bundle, so the assertion is about sentences and not about keys. */
const EN = JSON.parse(
  readFileSync(join(process.cwd(), "messages/en.json"), "utf8"),
) as {
  recordSharing: { lookingAfter: { kindManaged: string; kindShared: string } };
};

/** The i18n `t` as the banner receives it, resolved against the real bundle. */
const t = (key: string): string => {
  const leaf = key
    .split(".")
    .reduce<unknown>(
      (node, segment) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[segment]
          : undefined,
      EN,
    );
  if (typeof leaf !== "string") throw new Error(`unresolved key: ${key}`);
  return leaf;
};

describe("what the shared-record banner calls the record", () => {
  it("has a translator that really resolves", () => {
    // Positive control. A `t` that returned its own key would make both legs
    // below pass on the key names while proving nothing about the sentences.
    expect(t("recordSharing.lookingAfter.kindManaged")).toBe(
      EN.recordSharing.lookingAfter.kindManaged,
    );
    expect(EN.recordSharing.lookingAfter.kindManaged.length).toBeGreaterThan(3);
    expect(EN.recordSharing.lookingAfter.kindShared.length).toBeGreaterThan(3);
  });

  it("names a managed profile as one", () => {
    expect(recordKindLabel("managed", t)).toBe(
      EN.recordSharing.lookingAfter.kindManaged,
    );
  });

  it("names an ordinary shared record as one", () => {
    expect(recordKindLabel("shared", t)).toBe(
      EN.recordSharing.lookingAfter.kindShared,
    );
  });

  it("does not give the two the same sentence", () => {
    // The failure mode a pair of "contains" assertions cannot see.
    expect(recordKindLabel("managed", t)).not.toBe(
      recordKindLabel("shared", t),
    );
  });
});
