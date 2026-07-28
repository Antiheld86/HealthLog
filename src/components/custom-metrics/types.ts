/** The latest logged value carried on a custom-metric list row. */
export interface CustomMetricLatest {
  value: number;
  unit: string;
  measuredAt: string;
}

/** A user-defined custom metric as the API serialises it. */
export interface CustomMetricDto {
  id: string;
  name: string;
  unit: string;
  targetLow: number | null;
  targetHigh: number | null;
  decimals: number | null;
  description: string | null;
  correlationEnabled: boolean;
  /** Present on the list + create reads; absent on the bare detail read. */
  latest?: CustomMetricLatest | null;
  entryCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomMetricListResponse {
  customMetrics: CustomMetricDto[];
}

/** A single logged custom-metric value as the API serialises it. */
export interface CustomMetricEntryDto {
  id: string;
  customMetricId: string;
  value: number;
  unit: string;
  measuredAt: string;
  note: string | null;
  createdAt: string;
}

export interface CustomMetricEntryListResponse {
  entries: CustomMetricEntryDto[];
  meta: { total: number; limit: number; offset: number };
}
