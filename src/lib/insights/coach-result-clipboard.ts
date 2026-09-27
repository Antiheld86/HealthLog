/**
 * Copying a Coach result table: as tab-separated values and an HTML table
 * together (a spreadsheet takes the grid, a document takes the table), or
 * as plain text with aligned columns.
 *
 * The cells arrive already formatted the way the table shows them. Two
 * things are done to them on the way out:
 *
 *   - Formula injection. A cell that starts with `=`, `+`, `-` or `@` (or a
 *     tab / carriage return) is read by a spreadsheet as a formula, and a
 *     table can carry text the person did not type — a lab analyte read off
 *     an uploaded report. Such a cell gets a leading `'`, which spreadsheets
 *     treat as "this is text". A plain negative number is left alone.
 *   - Separators. A tab or line break inside a cell would split the grid;
 *     both become a space.
 *
 * Client-safe: no server import.
 */

/** One row of formatted cells; `null` is a period without a reading. */
export type ClipboardRow = ReadonlyArray<string | null>;

export interface ClipboardGrid {
  /** Column headings, units included. */
  header: ReadonlyArray<string>;
  rows: ReadonlyArray<ClipboardRow>;
  /** Right-align these columns in the plain-text form (the numbers). */
  alignRight?: ReadonlyArray<boolean>;
}

const FORMULA_START = /^[=+\-@\t\r]/;
const NEGATIVE_NUMBER = /^-\s?\d[\d\s.,  ]*$/;

/** A cell with its separators flattened and a formula start neutralised. */
export function sanitiseCell(value: string | null): string {
  if (value === null) return "";
  const flat = value.replace(/[\t\r\n]+/g, " ");
  if (FORMULA_START.test(flat) && !NEGATIVE_NUMBER.test(flat)) {
    return `'${flat}`;
  }
  return flat;
}

/** Tab-separated values, one line per row, the header first. */
export function toTsv(grid: ClipboardGrid): string {
  return [grid.header, ...grid.rows]
    .map((row) => row.map(sanitiseCell).join("\t"))
    .join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** An HTML table, every cell escaped, with an optional caption. */
export function toHtmlTable(grid: ClipboardGrid, caption?: string): string {
  const cell = (tag: "th" | "td", value: string | null) =>
    `<${tag}>${escapeHtml(sanitiseCell(value))}</${tag}>`;
  const head = `<thead><tr>${grid.header.map((h) => cell("th", h)).join("")}</tr></thead>`;
  const body = `<tbody>${grid.rows
    .map((row) => `<tr>${row.map((v) => cell("td", v)).join("")}</tr>`)
    .join("")}</tbody>`;
  const captionHtml = caption
    ? `<caption>${escapeHtml(caption)}</caption>`
    : "";
  return `<table>${captionHtml}${head}${body}</table>`;
}

/**
 * Plain text with the columns padded to line up in a monospaced font; a
 * period without a reading reads as "—". Separators are flattened, but no
 * formula guard: this form is for reading, not for a spreadsheet.
 */
export function toPlainText(grid: ClipboardGrid, caption?: string): string {
  const lines = [grid.header, ...grid.rows].map((row) =>
    row.map((value) =>
      value === null ? "—" : value.replace(/[\t\r\n]+/g, " "),
    ),
  );
  const widths = grid.header.map((_, index) =>
    Math.max(...lines.map((row) => [...(row[index] ?? "")].length)),
  );
  const body = lines.map((row) =>
    row
      .map((value, index) => {
        const pad = " ".repeat(widths[index] - [...value].length);
        return grid.alignRight?.[index] ? pad + value : value + pad;
      })
      .join("  ")
      .trimEnd(),
  );
  return [...(caption ? [caption] : []), ...body].join("\n");
}

/**
 * Put the table on the clipboard as TSV and HTML in one item. Falls back to
 * the TSV alone where `ClipboardItem` or `clipboard.write` is missing.
 * Rejects when neither works; the caller says so.
 */
export async function copyResultTable(
  grid: ClipboardGrid,
  caption?: string,
): Promise<void> {
  const tsv = toTsv(grid);
  const clipboard = navigator.clipboard;
  if (
    typeof ClipboardItem !== "undefined" &&
    typeof clipboard.write === "function"
  ) {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([tsv], { type: "text/plain" }),
          "text/html": new Blob([toHtmlTable(grid, caption)], {
            type: "text/html",
          }),
        }),
      ]);
      return;
    } catch {
      // Some browsers refuse the HTML flavour; the grid alone still helps.
    }
  }
  await clipboard.writeText(tsv);
}

/** Put the plain-text form on the clipboard. */
export async function copyResultText(
  grid: ClipboardGrid,
  caption?: string,
): Promise<void> {
  await navigator.clipboard.writeText(toPlainText(grid, caption));
}
