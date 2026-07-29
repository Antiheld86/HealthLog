import { CSV_EXAMPLE_COLUMNS } from "@/lib/import/csv-measurements";

/**
 * Small valid example payload, minted as a downloadable Blob by the
 * "Download example" button and used by the docs. Exported so a test can
 * assert it stays a valid import body — the button and the route schema
 * must never drift.
 */
export const EXAMPLE_IMPORT = {
  measurements: [
    {
      type: "WEIGHT",
      value: 80.5,
      unit: "kg",
      measuredAt: "2026-05-01T08:00:00.000Z",
      source: "manual",
      notes: "morning",
    },
    {
      type: "BLOOD_PRESSURE_SYS",
      value: 120,
      unit: "mmHg",
      measuredAt: "2026-05-01T08:05:00.000Z",
    },
    {
      type: "BLOOD_PRESSURE_DIA",
      value: 80,
      unit: "mmHg",
      measuredAt: "2026-05-01T08:05:00.000Z",
    },
  ],
  moodEntries: [
    {
      date: "2026-05-01",
      mood: "GUT",
      score: 4,
      tags: "work,exercise",
    },
  ],
};

/**
 * Stable, browser-native download target for the JSON example.
 *
 * A data URL is intentionally used instead of a short-lived Blob URL. It lets
 * the browser own the download directly from the anchor activation and avoids
 * a create/revoke race when the page is busy or Chromium delays consumption of
 * a synthetic Blob URL. The payload is small and contains example data only.
 */
export const EXAMPLE_IMPORT_DOWNLOAD_HREF =
  "data:application/json;charset=utf-8," +
  encodeURIComponent(JSON.stringify(EXAMPLE_IMPORT, null, 2));

/**
 * Client-side parse guard for the JSON-import textarea. Returns the
 * parsed value when the text is valid JSON, otherwise a failure marker —
 * we never POST an unparseable body. Exported for unit testing so the
 * guard is covered without a browser.
 */
export function parseImportJson(
  text: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Downloadable CSV example. Header is order-independent server-side, but the
 * example pins the documented order so the docs + the route schema never
 * drift. Exported so a test can assert it stays a valid header.
 */
export const EXAMPLE_CSV = [
  CSV_EXAMPLE_COLUMNS.join(","),
  "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,morning,",
  "BLOOD_GLUCOSE,5.3,mmol/L,2026-05-01T08:05:00+02:00,FASTING,,meter-001",
  // A sensor export has no fasting / post-meal answer per reading, so the
  // context cell is blank. The example carries that shape on purpose: it is
  // the one people copy, and it is the case that used to be refused.
  "BLOOD_GLUCOSE,5.9,mmol/L,2026-05-01T08:20:00+02:00,,,sensor-001",
  "BLOOD_PRESSURE_SYS,120,mmHg,2026-05-01T08:05:00+02:00,,,",
].join("\n");
