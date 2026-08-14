/**
 * OpenAPI route table — data import (CSV since v1.17.1, JSON since the
 * publication sweep that closed the create/poll gap).
 *
 * The CSV importer is the cold-start escape hatch for self-hosters migrating
 * from a spreadsheet or another tracker. The JSON importer (`/api/import`)
 * restores the structure `GET /api/export/json` emits. The Apple-Health
 * route (`/api/import/apple-health-export`) predates the contract surface
 * and remains undocumented here. iOS calls neither — its canonical ingest is
 * `POST /api/measurements/batch`.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  glucoseContextEnum,
  measurementTypeEnum,
} from "@/lib/validations/measurement";
import { moodLevelEnum } from "@/lib/validations/mood";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

const csvImportRowResult = z
  .object({
    line: z
      .number()
      .int()
      .describe("1-based source line number (the header is line 1)."),
    status: z.enum(["inserted", "updated", "skipped"]),
    reason: z
      .string()
      .optional()
      .describe(
        "Machine-readable reason for a non-inserted row (e.g. unknown_type, unknown_unit, missing_timezone_offset, value_out_of_range, implausible_timestamp, duplicate).",
      ),
  })
  .meta({ id: "CsvImportRowResult" });

const csvImportResponse = z
  .object({
    inserted: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    total: z
      .number()
      .int()
      .describe("Total data rows parsed (excludes header)."),
    dryRun: z.boolean(),
    rows: z.array(csvImportRowResult),
  })
  .meta({
    id: "CsvImportResponse",
    description:
      "Per-row import outcome. Mirrors the batch-route per-entry envelope. In `dryRun` mode no write runs and every valid row reports its projected `inserted` status.",
  });

// ── JSON import — mirrors the route-local `importSchema`
// (`src/app/api/import/route.ts`), which is deliberately not exported: the
// runtime side carries transforms + plausibility refinements the document
// restates in prose.

const jsonImportMeasurement = z
  .object({
    type: measurementTypeEnum,
    value: z
      .number()
      .describe(
        "Checked against the type's server-side plausibility range; an out-of-range value fails the whole request with 422.",
      ),
    unit: z.string(),
    measuredAt: z.iso
      .datetime({ offset: true })
      .describe(
        "Bounded: no future instants beyond a 5-min clock-skew tolerance, nothing before 1900.",
      ),
    glucoseContext: glucoseContextEnum
      .optional()
      .describe(
        "Optional even on a BLOOD_GLUCOSE row — a sensor export classifies nothing per sample.",
      ),
    source: z
      .string()
      .optional()
      .describe(
        "Accepted for export-format compatibility and ignored: every imported row stores `source = IMPORT`.",
      ),
    notes: z.string().optional().describe("Encrypted at rest."),
    externalId: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Source-stable id making re-import idempotent (upsert on `(userId, type, source=IMPORT, externalId)`; a re-import updates the row in place). Absent → first-write-wins create with a NULL key, which DOES duplicate on re-import. An unstable id (an object description or memory address that rotates per launch) skips THIS row, never the file.",
      ),
  })
  .meta({
    id: "JsonImportMeasurement",
    description: "One measurement row of a JSON import file.",
  });

const jsonImportMoodEntry = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("Local-day label, YYYY-MM-DD."),
    mood: moodLevelEnum,
    score: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe(
        "Stored as sent — the export format's own field. Pleasantness (`a1`) is re-derived from `mood` on every imported row, never taken from this.",
      ),
    tags: z
      .string()
      .optional()
      .describe("JSON-encoded array of tag strings, stored verbatim."),
    loggedAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Bounded like `measuredAt`. Absent → the server derives a stable per-row instant within the `date` day, so a re-import of the same file dedups instead of duplicating.",
      ),
    externalId: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Source-stable id (e.g. a Daylio row id) making re-import idempotent (upsert on `(userId, source=IMPORT, externalId)`). Same stability rule as the measurement `externalId`: an unstable id skips the row.",
      ),
  })
  .meta({
    id: "JsonImportMoodEntry",
    description: "One mood-entry row of a JSON import file.",
  });

const jsonImportRequest = z
  .object({
    measurements: z.array(jsonImportMeasurement).max(10000).optional(),
    moodEntries: z.array(jsonImportMoodEntry).max(10000).optional(),
  })
  .meta({
    id: "JsonImportRequest",
    description:
      "JSON import payload, matching the structure `GET /api/export/json` emits. Both sections optional; up to 10 000 rows each.",
  });

const jsonImportStats = z
  .object({
    measurements: z
      .number()
      .int()
      .nonnegative()
      .describe("Measurement rows written (inserted or updated in place)."),
    moodEntries: z
      .number()
      .int()
      .nonnegative()
      .describe("Mood-entry rows written (inserted or updated in place)."),
    skipped: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Rows not written: duplicates of existing rows, and rows carrying an unstable `externalId`.",
      ),
  })
  .meta({
    id: "JsonImportStats",
    description: "Per-section outcome counts of a JSON import.",
  });

export const importPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/import/csv": {
    post: {
      tags: ["Import"],
      summary: "Import measurements from CSV",
      description:
        "Bulk-import measurements from a CSV file (web cold-start escape hatch). Body is raw `text/csv` (≤ 16 MB, ≤ 10 000 valid rows). Header (order-independent): `type,value,unit,measuredAt[,glucoseContext,notes,externalId]`. `measuredAt` must carry an explicit ISO-8601 offset and is bounded (no future beyond a 5-min skew, no instant before 1900). Glucose accepts `mmol/L` (converted to canonical `mg/dL`); weight accepts `lb` (converted to `kg`). `glucoseContext` is optional on a `BLOOD_GLUCOSE` row — a blank cell stores no context, which is the normal shape of a continuous-sensor export; a non-empty value is still checked against the enum, and the column is refused on any other type. An `externalId` column makes re-upload idempotent (upsert on `(userId, type, source=IMPORT, externalId)`); without it a re-upload duplicates. `?dryRun=1` validates + previews without writing. Shares the 5/hour `import:` rate bucket.",
      parameters: [
        {
          name: "dryRun",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["1", "true"] },
          description:
            "When `1` / `true`, parse + validate + return the per-row envelope without writing.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "text/csv": {
            schema: {
              type: "string",
              example:
                "type,value,unit,measuredAt,glucoseContext,notes,externalId\nWEIGHT,80.5,kg,2026-05-01T08:00:00Z,,morning,\nBLOOD_GLUCOSE,5.3,mmol/L,2026-05-01T08:05:00+02:00,FASTING,,meter-001\nBLOOD_GLUCOSE,5.9,mmol/L,2026-05-01T08:20:00+02:00,,,sensor-001",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Per-row import outcome.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                csvImportResponse,
                "CsvImportResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        "413": {
          description: "CSV exceeds the 16 MB limit.",
          content: {
            "application/json": {
              schema: dataEnvelope(z.null(), "CsvImportTooLargeEnvelope"),
            },
          },
        },
      },
    },
  },
  "/api/import": {
    post: {
      tags: ["Import"],
      summary: "Import measurements and mood entries from JSON",
      description:
        "Restores a JSON export (the structure `GET /api/export/json` emits): up to 10 000 measurements plus 10 000 mood entries per call, body ≤ 16 MB. Rows carrying an `externalId` upsert idempotently (re-import updates in place); rows without one are first-write-wins and dedup against the existing unique keys, so an exact duplicate is `skipped` rather than doubled. A row with an unstable `externalId` is skipped while the rest of the file still lands. Every imported measurement stores `source = IMPORT`; every imported mood entry re-derives pleasantness from its label. Writes are per-row, not transactional: on a mid-file write failure the response is 503 (`meta.errorCode` = `import.write_failed`, `meta.retryable` = true) with `meta.stats` carrying what landed — rows already written stay written, and a retry is only safe against duplication for rows that carry an `externalId`. Validation is fail-fast (the 422 carries the first issue's message, not the multi-issue envelope). Rate-limited 5/hour per user (shared `import:` bucket with the CSV importer).",
      requestBody: {
        required: true,
        content: { "application/json": { schema: jsonImportRequest } },
      },
      responses: {
        "200": {
          description: "Import completed; per-section outcome counts.",
          content: {
            "application/json": {
              schema: dataEnvelope(jsonImportStats, "JsonImportStatsEnvelope"),
            },
          },
        },
        ...stdResponses,
        "413": {
          description: "Body exceeds the 16 MB limit.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description:
            "A write failed partway through the file. `meta.errorCode` = `import.write_failed`, `meta.retryable` = true, `meta.stats` carries the counts that landed before the failure. Rows already written stay written; retry the same file — rows with `externalId` re-import idempotently, rows without one may duplicate.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
