/**
 * OpenAPI route table — server capabilities discovery.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { dataEnvelope, stdResponses } from "./shared";

// v1.10.2 — live capability / discovery response. Every list is sourced
// server-side from the canonical registry it documents, so the wire shape
// here is the contract; the runtime values are authoritative and never
// hand-duplicated. Used by the native client to gate its UI / decoder
// against what the server actually ships (retires the doc-vs-server
// enum-drift class).
const capabilitiesResponse = z
  .object({
    apiContractVersion: z
      .string()
      .describe("Running build version — mirrors GET /api/version `version`."),
    derivedMetricIds: z
      .array(z.string())
      .describe("Closed derived-metric id set (GET /api/insights/derived)."),
    vitalsBaselineTypes: z
      .array(z.string())
      .describe("MeasurementTypes the typical-range baseline engine supports."),
    layoutTileIds: z
      .array(z.string())
      .describe("Canonical insights layout tile-id set (English ids)."),
    metricStatusIds: z
      .array(z.string())
      .describe("Closed metric-status / assessment id set."),
    ingest: z
      .object({
        quantityTypes: z
          .array(
            z.object({
              type: z.string().describe("HealthLog MeasurementType."),
              hk: z.string().describe("HealthKit identifier."),
              unit: z.string().describe("Canonical DB unit."),
            }),
          )
          .describe("Accepted HealthKit quantity-sample mappings."),
        eventTypes: z
          .array(z.string())
          .describe(
            "MeasurementTypes for device-flagged EVENT-class HealthKit samples.",
          ),
        computedScores: z
          .array(z.string())
          .describe("Server-owned nightly composite score types."),
        writeAllowlist: z
          .array(z.string())
          .describe(
            "MeasurementSources a client may attribute on a write (others are server-owned).",
          ),
      })
      .describe("Ingest vocabularies the batch / single-write paths accept."),
    fhir: z
      .object({
        atcSystem: z.string().describe("WHO ATC CodeSystem URI."),
        snomedRoute: z.string().describe("SNOMED CT CodeSystem URI."),
        germanAtcDefaultLocales: z
          .array(z.string())
          .describe(
            "App locales that default the additive BfArM ATC coding on.",
          ),
        restBaseUrl: z
          .string()
          .describe("Base path of the read-only FHIR R4 REST face."),
        readScope: z
          .string()
          .describe("Bearer scope a narrow token needs to read the FHIR face."),
        resourceTypes: z
          .array(z.string())
          .describe(
            "FHIR resource types the REST face serves (read + search).",
          ),
        operations: z
          .array(z.string())
          .describe("Whole-record operations exposed (e.g. $everything)."),
        searchParams: z
          .array(z.string())
          .describe(
            "Search parameters honoured uniformly across the search routes.",
          ),
      })
      .describe(
        "FHIR coding constants + the read-only REST face descriptor (v1.11).",
      ),
    share: z
      .object({
        supported: z
          .boolean()
          .describe("Whether clinician share links are served."),
        maxDays: z
          .number()
          .int()
          .describe(
            "Maximum lifetime of a share link, in days. No never-expiring share.",
          ),
        reportDownload: z
          .array(z.string())
          .describe(
            "Machine formats a share link serves as a download under its token, behind the same unlock as the page.",
          ),
        selectionVersion: z
          .number()
          .int()
          .describe("Version of the leaf-selection grammar this build speaks."),
        groups: z
          .array(z.string())
          .describe("Selection group ids, in presentation order."),
        leaves: z
          .array(z.string())
          .describe(
            "Every leaf id a report selection may carry. Membership is inclusion; absence is exclusion.",
          ),
      })
      .describe("Clinician share-link surface descriptor."),
  })
  .meta({
    id: "CapabilitiesResponse",
    description:
      "Live id vocabularies + contract version. Every list is derived server-side from the canonical registry it documents, so it cannot drift from the values the routes actually accept/emit.",
  });

// v1.4.41 — the measurement categorisation overlay iOS reads on cold start
// to drive the HealthKit permission picker (one consent screen per
// category). Every value is sourced server-side from the canonical
// `MEASUREMENT_CATEGORIES` map, so the wire shape here is the contract.
const measurementCategoriesResponse = z
  .object({
    version: z
      .literal(1)
      .describe("Additive schema marker; assignments never reshuffle."),
    categories: z
      .array(
        z.object({
          id: z.string().describe("Category id (e.g. `vitals`)."),
          labelKey: z
            .string()
            .describe("i18n key for the category label (`categories.<id>`)."),
          order: z.number().int().describe("Stable display order."),
        }),
      )
      .describe("The ordered category list for the picker."),
    assignments: z
      .record(z.string(), z.string())
      .describe("MeasurementType → category id map."),
  })
  .meta({
    id: "MeasurementCategoriesResponse",
    description:
      "The measurement categorisation overlay: the ordered category list plus the MeasurementType → category assignments. Derived server-side from the canonical map; cached `public, max-age=600`.",
  });

export const metaPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/measurement-categories": {
    get: {
      tags: ["Meta"],
      summary: "Measurement categorisation overlay",
      description:
        "Returns the UI-side measurement categorisation as an HTTP contract: the ordered category list (id + i18n label key + order) plus the MeasurementType → category assignments. iOS reads this on cold start to drive the HealthKit permission picker (one consent screen per category) and caches it client-side (`Cache-Control: public, max-age=600`). Auth via cookie or Bearer (not admin); no PII.",
      responses: {
        "200": {
          description: "Categorisation overlay.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                measurementCategoriesResponse,
                "MeasurementCategoriesEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/meta/capabilities": {
    get: {
      tags: ["Meta"],
      summary: "Live server capability / id-vocabulary discovery",
      description:
        "Returns the server's REAL id vocabularies (derived-metric ids, vitals-baseline types, layout tile-ids, metric-status ids, the HealthKit ingest mapping, the FHIR coding constants) plus the running API contract version. Every list is derived server-side from the canonical registry it documents, so a client can gate its UI / decoder against what the server actually ships rather than a hand-maintained copy. Auth via cookie or Bearer (not admin).",
      responses: {
        "200": {
          description: "Capability snapshot.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                capabilitiesResponse,
                "CapabilitiesEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
