/**
 * v1.25.5 — server-side serialisers for the user-defined custom-metric store.
 *
 * Custom metrics are PLAINTEXT (name / unit / description), so — unlike the
 * Biomarker catalog with its AES-256-GCM `contextEncrypted` codec — there is no
 * encrypt/decrypt layer here. These helpers just map a Prisma row into the
 * stable wire DTO the web + iOS clients render.
 *
 * The store is deliberately ISOLATED from the closed `MeasurementType` system:
 * no rollup, no sync, no FHIR, no insights. Charts read entries LIVE.
 */

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
  note: string | null;
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
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}
