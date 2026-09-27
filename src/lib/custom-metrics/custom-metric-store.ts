/**
 * v1.25.5 — server-side serialisers for the user-defined custom-metric store.
 *
 * The catalog columns (name / unit / description) are plaintext: they are the
 * definition of a series and are listed and sorted by. The one free-text field
 * on a reading, its note, is AES-256-GCM at rest since v1.39.3
 * (`noteEncrypted`), read here through the shared note boundary. These
 * helpers map a Prisma row into the stable wire DTO the web + iOS clients
 * render.
 *
 * The store is deliberately ISOLATED from the closed `MeasurementType` system:
 * no rollup, no sync, no FHIR, no insights. Charts read entries LIVE.
 */

import { readNote } from "@/lib/crypto/note-cipher";

/** A custom-metric catalog row as the API serialises it. */
export interface CustomMetricRow {
  id: string;
  name: string;
  unit: string;
  targetLow: number | null;
  targetHigh: number | null;
  decimals: number | null;
  description: string | null;
  correlationEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A custom-metric catalog row plus its latest logged value (list read). */
export interface CustomMetricRowWithLatest extends CustomMetricRow {
  latest: { value: number; unit: string; measuredAt: Date } | null;
  entryCount: number;
}

/** A logged custom-metric value as the API serialises it. */
export interface CustomMetricEntryRow {
  id: string;
  customMetricId: string;
  value: number;
  unit: string;
  measuredAt: Date;
  /** Legacy readable note, set only on rows the backfill has not reached. */
  note: string | null;
  noteEncrypted: Uint8Array | null;
  createdAt: Date;
}

export function serialiseCustomMetric(row: CustomMetricRow) {
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    targetLow: row.targetLow,
    targetHigh: row.targetHigh,
    decimals: row.decimals,
    description: row.description,
    correlationEnabled: row.correlationEnabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serialiseCustomMetricWithLatest(
  row: CustomMetricRowWithLatest,
) {
  return {
    ...serialiseCustomMetric(row),
    latest: row.latest
      ? {
          value: row.latest.value,
          unit: row.latest.unit,
          measuredAt: row.latest.measuredAt.toISOString(),
        }
      : null,
    entryCount: row.entryCount,
  };
}

export function serialiseCustomMetricEntry(row: CustomMetricEntryRow) {
  return {
    id: row.id,
    customMetricId: row.customMetricId,
    value: row.value,
    unit: row.unit,
    measuredAt: row.measuredAt.toISOString(),
    note: readNote(row.noteEncrypted, row.note),
    createdAt: row.createdAt.toISOString(),
  };
}
