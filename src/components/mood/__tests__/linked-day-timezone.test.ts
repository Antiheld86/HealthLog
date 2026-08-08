/**
 * Which zone a linked-day read is made in, and which surface decides it.
 *
 * The finding this file answers was not a wrong number — it was a doc comment
 * that said "the detail view passes the entry's stored tz" beside code that
 * always sent the browser's. Nothing was red, because nothing asserted the
 * claim. Two ends, so two kinds of assertion:
 *
 *   * the resolution itself, on the pure helper, at both branches;
 *   * the two call sites, structurally, because the resolution being right is
 *     worth nothing if the edit dialog never hands it the entry's zone.
 *
 * Both matchers assert a non-zero match count. An empty match set fails rather
 * than passing quietly, which is how a guard stays a guard after somebody
 * renames the thing it greps for.
 *
 * Mutation check: drop the `editing?.tz` argument at the edit call site and
 * the call-site row goes red; make the helper prefer its browser argument and
 * the resolution rows go red.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { linkedDayRequest } from "../use-linked-day-context";

const HERE = join(__dirname, "..");
const LIST = readFileSync(join(HERE, "mood-list.tsx"), "utf8");
const FORM = readFileSync(join(HERE, "mood-form.tsx"), "utf8");

/** The arguments of every `useLinkedDayContext(...)` call in a source file. */
function callArguments(source: string): string[] {
  const calls: string[] = [];
  const needle = "useLinkedDayContext(";
  let at = source.indexOf(needle);
  while (at !== -1) {
    // Only a CALL, never the import line that names the same identifier.
    const open = at + needle.length - 1;
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    calls.push(source.slice(open + 1, end));
    at = source.indexOf(needle, end);
  }
  return calls;
}

describe("linked-day timezone", () => {
  it("prefers a stored zone over the browser's", () => {
    const { tz, url } = linkedDayRequest(
      "2026-06-11",
      "America/New_York",
      "Europe/Berlin",
    );
    expect(tz).toBe("America/New_York");
    expect(url).toContain("tz=America%2FNew_York");
    expect(url).toContain("date=2026-06-11");
  });

  it("falls back to the browser's zone when the row has none", () => {
    // A legacy row (`tz IS NULL`) and an entry that does not exist yet are the
    // same case here. Not Europe/Berlin: the server owns the legacy rule and a
    // guess sent from the client would override the one place it is written.
    expect(linkedDayRequest("2026-06-11", null, "Europe/Berlin").tz).toBe(
      "Europe/Berlin",
    );
    expect(linkedDayRequest("2026-06-11", "", "Europe/Berlin").tz).toBe(
      "Europe/Berlin",
    );
    expect(linkedDayRequest("2026-06-11", undefined, "Asia/Tokyo").tz).toBe(
      "Asia/Tokyo",
    );
  });

  it("has the edit dialog hand over the entry's own zone", () => {
    const calls = callArguments(LIST);
    expect(
      calls.length,
      "no useLinkedDayContext call found in mood-list.tsx — this matcher proves nothing",
    ).toBe(1);
    expect(
      calls[0],
      "the edit dialog reads the linked day under the browser's zone; an entry logged abroad would be looked up on the wrong day",
    ).toContain("editing?.tz");
  });

  it("leaves the capture sheet on the browser's zone", () => {
    const calls = callArguments(FORM);
    expect(
      calls.length,
      "no useLinkedDayContext call found in mood-form.tsx — this matcher proves nothing",
    ).toBe(1);
    // A new entry has no stored zone to pass, so the third argument is absent
    // on purpose. Passing something here would be inventing a zone for a row
    // that has not chosen one.
    expect(calls[0]).not.toContain("tz");
  });
});
