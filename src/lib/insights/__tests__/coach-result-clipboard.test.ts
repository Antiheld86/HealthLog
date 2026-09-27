/**
 * v1.39.4 — copying a result table: a grid a spreadsheet parses back, cells
 * that cannot start a formula, escaped HTML, aligned text, and the fallback
 * when the rich clipboard is missing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  copyResultTable,
  copyResultText,
  sanitiseCell,
  toHtmlTable,
  toPlainText,
  toTsv,
  type ClipboardGrid,
} from "../coach-result-clipboard";

const GRID: ClipboardGrid = {
  header: ["Day", "Systolic (mmHg)", "Readings"],
  rows: [
    ["Sep 21, 2026", "131", "2"],
    ["Sep 22, 2026", null, null],
    ["Sep 23, 2026", "-4.5", "1"],
  ],
  alignRight: [false, true, true],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sanitiseCell", () => {
  it.each([
    ['=HYPERLINK("http://x")', '\'=HYPERLINK("http://x")'],
    ["+1+2", "'+1+2"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
  ])("neutralises a formula start: %s", (input, expected) => {
    expect(sanitiseCell(input)).toBe(expected);
  });

  it.each([
    ["\t=1", "' =1"],
    ["  =1+1", "'  =1+1"],
    ["\u00a0@SUM(A1)", "'\u00a0@SUM(A1)"],
    ["\uff1d1+1", "'\uff1d1+1"],
    ["\uff0b1", "'\uff0b1"],
    ["\uff0d1+1", "'\uff0d1+1"],
    ["\uff20SUM(A1)", "'\uff20SUM(A1)"],
    ["|cmd", "'|cmd"],
    [" |cmd", "' |cmd"],
  ])(
    "neutralises a formula start behind whitespace or in fullwidth: %j",
    (input, expected) => {
      expect(sanitiseCell(input)).toBe(expected);
    },
  );

  it("leaves plain negatives and ordinary text alone", () => {
    expect(sanitiseCell("-4.5")).toBe("-4.5");
    expect(sanitiseCell("-1 234,5")).toBe("-1 234,5");
    expect(sanitiseCell(" -4.5")).toBe(" -4.5");
    expect(sanitiseCell("LDL")).toBe("LDL");
    expect(sanitiseCell(null)).toBe("");
  });

  it("flattens tabs and line breaks inside a cell", () => {
    expect(sanitiseCell("two\tparts\nhere")).toBe("two parts here");
  });
});

describe("toTsv", () => {
  it("round-trips into the same grid a spreadsheet would read", () => {
    const tsv = toTsv({
      header: GRID.header,
      rows: [...GRID.rows, ["line\nbreak", "=cmd|' /C calc'!A0", "3"]],
    });
    const parsed = tsv.split("\n").map((line) => line.split("\t"));
    expect(parsed).toEqual([
      ["Day", "Systolic (mmHg)", "Readings"],
      ["Sep 21, 2026", "131", "2"],
      ["Sep 22, 2026", "", ""],
      ["Sep 23, 2026", "-4.5", "1"],
      ["line break", "'=cmd|' /C calc'!A0", "3"],
    ]);
    // Every row has the same width: no cell split or swallowed a column.
    expect(new Set(parsed.map((row) => row.length)).size).toBe(1);
  });
});

describe("toHtmlTable", () => {
  it("escapes every cell and the caption", () => {
    const html = toHtmlTable(
      {
        header: ["<b>Test</b>"],
        rows: [["<img src=x onerror=alert(1)>"], ["a & 'b'"]],
      },
      'Labs "latest"',
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("a &amp; &#39;b&#39;");
    expect(html).toContain("<caption>Labs &quot;latest&quot;</caption>");
  });
});

describe("toPlainText", () => {
  it("lines the columns up and shows a missing reading as a dash", () => {
    const text = toPlainText(GRID, "Blood pressure by day");
    expect(text.split("\n")).toEqual([
      "Blood pressure by day",
      "Day           Systolic (mmHg)  Readings",
      "Sep 21, 2026              131         2",
      "Sep 22, 2026                —         —",
      "Sep 23, 2026             -4.5         1",
    ]);
  });
});

describe("copyResultTable", () => {
  it("writes TSV and HTML as one clipboard item", async () => {
    const write = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    class FakeItem {
      constructor(public items: Record<string, Blob>) {}
    }
    vi.stubGlobal("ClipboardItem", FakeItem);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    await copyResultTable(GRID, "Blood pressure by day");
    expect(write).toHaveBeenCalledTimes(1);
    const [[items]] = write.mock.calls as unknown as [[FakeItem[]]];
    expect(Object.keys(items[0].items).sort()).toEqual([
      "text/html",
      "text/plain",
    ]);
    expect(await items[0].items["text/plain"].text()).toBe(toTsv(GRID));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to the TSV alone without ClipboardItem", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyResultTable(GRID);
    expect(writeText).toHaveBeenCalledWith(toTsv(GRID));
  });

  it("falls back when the rich write is refused", async () => {
    const write = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("ClipboardItem", class {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    await copyResultTable(GRID);
    expect(writeText).toHaveBeenCalledWith(toTsv(GRID));
  });

  it("copies the aligned text on request", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyResultText(GRID, "Title");
    expect(writeText).toHaveBeenCalledWith(toPlainText(GRID, "Title"));
  });
});
