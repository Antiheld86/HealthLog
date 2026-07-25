/**
 * OpenAPI route table — CSV measurement import (v1.17.1).
 *
 * The CSV importer is the cold-start escape hatch for self-hosters migrating
 * from a spreadsheet or another tracker. The JSON (`/api/import`) and Apple-
 * Health (`/api/import/apple-health-export`) routes predate the contract
 * surface and are intentionally not documented here; this module documents
 * the one new endpoint so the wire contract stays drift-free (CI gate). iOS
 * does not call it — its canonical ingest is `POST /api/measurements/batch`.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import { dataEnvelope, stdResponses } from "./shared";

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
};
