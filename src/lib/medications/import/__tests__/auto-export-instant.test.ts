/**
 * The offset in an exported timestamp survives, or the row is refused.
 *
 * `2023-02-16 08:38:00 +1030` is not ISO 8601 — a space instead of `T`, a
 * compact offset with no colon — so handing it to the platform's date parser is
 * relying on leniency, not on a contract. Getting it wrong moves every dose in a
 * file by hours, silently, and no later edit recovers the original.
 *
 * These assert the epoch arithmetic directly rather than round-tripping through
 * a formatter, because a formatter that shares the same mistake would agree.
 */
import { describe, expect, it } from "vitest";

import { parseAutoExportInstant } from "../auto-export-instant";

describe("parseAutoExportInstant", () => {
  it("reads a compact positive offset as the offset the file states", () => {
    const result = parseAutoExportInstant("2023-02-16 08:38:00 +1030");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 08:38 at +10:30 is 22:08 the previous day in UTC. Written out rather than
    // computed so a shared error cannot make both sides agree.
    expect(result.instant.toISOString()).toBe("2023-02-15T22:08:00.000Z");
    expect(result.offsetMinutes).toBe(630);
  });

  it("reads a negative offset in the other direction", () => {
    const result = parseAutoExportInstant("2024-01-01 08:00:00 -0800");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instant.toISOString()).toBe("2024-01-01T16:00:00.000Z");
    expect(result.offsetMinutes).toBe(-480);
  });

  it("keeps two adjacent rows of one file an hour apart across a DST change", () => {
    // The reported export carries +1030 and +0930 on rows weeks apart, because
    // the source zone observes summer time. Both rows say 08:30 locally; they
    // are one hour apart as instants, and collapsing them onto one zone would
    // erase that.
    const summer = parseAutoExportInstant("2025-10-08 08:30:00 +1030");
    const winter = parseAutoExportInstant("2025-06-29 08:30:00 +0930");
    expect(summer.ok && winter.ok).toBe(true);
    if (!summer.ok || !winter.ok) return;
    expect(summer.instant.toISOString()).toBe("2025-10-07T22:00:00.000Z");
    expect(winter.instant.toISOString()).toBe("2025-06-28T23:00:00.000Z");
    expect(summer.offsetMinutes - winter.offsetMinutes).toBe(60);
  });

  it("accepts the colon-separated and Z spellings of the same instant", () => {
    const compact = parseAutoExportInstant("2025-03-01 12:00:00 +0100");
    const colon = parseAutoExportInstant("2025-03-01T12:00:00+01:00");
    const zulu = parseAutoExportInstant("2025-03-01 11:00:00 Z");
    expect(compact.ok && colon.ok && zulu.ok).toBe(true);
    if (!compact.ok || !colon.ok || !zulu.ok) return;
    expect(colon.instant.getTime()).toBe(compact.instant.getTime());
    expect(zulu.instant.getTime()).toBe(compact.instant.getTime());
  });

  it("refuses a timestamp with no offset instead of assuming a zone", () => {
    // The server's zone is not evidence about where a dose was taken. Reading
    // this as local time would shift the whole file by the server's offset.
    expect(parseAutoExportInstant("2023-02-16 08:38:00")).toEqual({
      ok: false,
      failure: "missing_offset",
    });
  });

  it("tells an absent cell apart from an unreadable one", () => {
    expect(parseAutoExportInstant("")).toEqual({
      ok: false,
      failure: "absent",
    });
    expect(parseAutoExportInstant("   ")).toEqual({
      ok: false,
      failure: "absent",
    });
    expect(parseAutoExportInstant("16/02/2023 8.38am")).toEqual({
      ok: false,
      failure: "unreadable",
    });
  });

  it("refuses a day the calendar does not have", () => {
    // `Date.UTC` rolls February 30 over to March 2. Accepting it would move the
    // dose two days and report success.
    expect(parseAutoExportInstant("2023-02-30 08:00:00 +0000")).toEqual({
      ok: false,
      failure: "out_of_range",
    });
  });

  it("refuses an out-of-range clock or offset", () => {
    expect(parseAutoExportInstant("2023-02-16 25:00:00 +0000").ok).toBe(false);
    expect(parseAutoExportInstant("2023-02-16 08:61:00 +0000").ok).toBe(false);
    expect(parseAutoExportInstant("2023-02-16 08:00:00 +1599").ok).toBe(false);
    expect(parseAutoExportInstant("2023-02-16 08:00:00 +0075").ok).toBe(false);
  });
});
