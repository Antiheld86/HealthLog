/**
 * OpenAPI route table for structured family history (`/api/family-history`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * bodies + queries reuse the runtime Zod schemas from
 * `@/lib/validations/family-history` so the wire contract stays single-source.
 * Response shapes mirror the server-authoritative DTOs in
 * `@/lib/records/dto.ts` (the routes serialise a decrypted `note` the input
 * schemas don't carry; iOS renders the DTO, it never recomputes it).
 *
 * A structured FamilyMemberHistory-style RECORD — patient-reported, never a
 * clinical diagnosis. Owner-scoped; auth-gated.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  familyHistoryCreateSchema,
  familyHistoryUpdateSchema,
  familyHistoryListQuerySchema,
  familyRelationshipEnum,
} from "@/lib/validations/family-history";

import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  stdResponses,
} from "./shared";

// Zod 4's `.meta()` returns a NEW instance carrying the id rather than
// annotating in place, so each annotated schema is bound to a const and the
// route table below references that const — a bare call would register nothing.
const createFamilyHistoryRequest = familyHistoryCreateSchema.meta({
  id: "CreateFamilyHistoryRequest",
  description:
    "Record one condition for one relative (a FHIR FamilyMemberHistory with a single condition). `condition` is the user-facing label (the `condition.code.text` anchor — never a machine-guessed code); `ageAtOnset` is the relative's age (years) when it began. The free-text `note` is encrypted at rest. Patient-reported.",
});

const updateFamilyHistoryRequest = familyHistoryUpdateSchema.meta({
  id: "UpdateFamilyHistoryRequest",
  description:
    "Partial edit of a family-history entry; an omitted key leaves the column untouched. A `null` `ageAtOnset`/`note` clears that field. Rejects unknown keys.",
});

const listFamilyHistoryQuery = familyHistoryListQuerySchema.meta({
  id: "ListFamilyHistoryQuery",
  description:
    "Query params for the family-history list: optional `limit` (1–200, default 100). Newest-first.",
});

const familyHistoryEntry = z
  .object({
    id: z.string(),
    relationship: familyRelationshipEnum,
    condition: z.string(),
    ageAtOnset: z.number().int().nullable(),
    note: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "FamilyHistoryEntry",
    description:
      "A stored family-history entry: one condition for one relative. `note` is the decrypted free-text (or null on a key-rotation gap — fail-soft, never 500). `ageAtOnset` is null when unknown.",
  });

const entryNotFound = {
  "404": {
    description: "Family history entry not found (or owned by another user).",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

export const familyHistoryPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/family-history": {
    get: {
      tags: ["Records"],
      summary: "List family history (v1.25)",
      description:
        "Returns the caller's live (non-deleted) family-history entries, newest-first.",
      requestParams: { query: listFamilyHistoryQuery },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The caller's family-history entries.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(familyHistoryEntry),
                "ListFamilyHistoryEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Records"],
      summary: "Record a family-history entry (v1.25)",
      description:
        "Creates one condition-by-relative record for the caller. The free-text note is AES-256-GCM encrypted before write. Audits as `family-history.create`.",
      parameters: [idempotencyKeyParameter],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: createFamilyHistoryRequest },
        },
      },
      responses: {
        ...idempotentWrite(),
        ...recordRefusal(),
        "201": {
          description: "Entry created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                familyHistoryEntry,
                "CreateFamilyHistoryEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/family-history/{id}": {
    get: {
      tags: ["Records"],
      summary: "Read a single family-history entry (v1.25)",
      description:
        "Returns the entry including its decrypted `note`. Owner-scoped; a cross-user or tombstoned id 404s.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The family-history entry.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                familyHistoryEntry,
                "GetFamilyHistoryEnvelope",
              ),
            },
          },
        },
        ...entryNotFound,
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Records"],
      summary: "Edit a family-history entry (v1.25)",
      description:
        "Partial edit; omitted fields are left untouched. Audits as `family-history.update`. Owner-scoped.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: updateFamilyHistoryRequest },
        },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Entry updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                familyHistoryEntry,
                "UpdateFamilyHistoryEnvelope",
              ),
            },
          },
        },
        ...entryNotFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Records"],
      summary: "Soft-delete a family-history entry (v1.25)",
      description:
        "Stamps `deletedAt` (tombstone). Idempotent — a re-delete is a no-op. Returns the `{ deleted: true }` envelope. Audits as `family-history.delete`. Owner-scoped.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Soft-deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteFamilyHistoryEnvelope",
              ),
            },
          },
        },
        ...entryNotFound,
        ...stdResponses,
      },
    },
  },
};
