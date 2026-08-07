/**
 * OpenAPI path table — medications CRUD, intake, cadence, compliance, AI extraction.
 *
 * Schema declarations live in `./schemas`; this module is the path orchestrator.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import {
  createMedicationSchema,
  updateMedicationSchema,
  intakeSchema,
  createInventoryItemSchema,
  updateInventoryItemSchema,
  injectionSiteEnum,
} from "@/lib/validations/medication";
import { medicationExtractionSchema } from "@/lib/ai/coach/medication-extract-prompt";
import {
  scheduleRevisionCreateSchema,
  scheduleRevisionUpdateSchema,
} from "@/lib/validations/schedule-revision";
import {
  efficacyTargetOverrideSchema,
  medicationEfficacyResponseSchema,
} from "@/lib/validations/medication-efficacy";
import {
  conflictResponse409,
  dataEnvelope,
  errorEnvelope,
  invalidBaseTokenResponse,
  recordRefusal,
  stdResponses,
} from "../shared";

efficacyTargetOverrideSchema.meta({
  id: "SetMedicationEfficacyTargetRequest",
  description:
    "Set or clear the user's explicit efficacy-target override for a medication. `clear:true` removes the override so the resolver reverts to the derived (ATC class prefix → name inference) target; otherwise pin exactly ONE of `measurementType` (a metric series) / `biomarkerId` (a lab analyte). `userId` is never a field — ownership is narrowed through the medication (and the biomarker for a lab target).",
});

medicationEfficacyResponseSchema.meta({
  id: "MedicationEfficacyResponse",
  description:
    "Server-authoritative, strictly-descriptive efficacy view relating a medication to the outcome metric(s)/lab(s) its class is prescribed to move, around its start. Carries the resolved target(s) with their series, the start/dose-change/pause markers, a before/after-start comparison (honest `{present:false}` below the per-side data floor), an adherence lane (cadence-aware per-day rate, never recomputed), an optional conservative level-shift note, and the retarget options. There is NO verdict / score / assessment field by construction — the client renders numbers and neutral connective phrasing only, never a causal or dose-advice claim.",
});
import {
  medicationListEntry,
  medicationDetailEntry,
  medicationInventoryItemResource,
  medicationSupplySummaryResource,
  medicationIntakeEventResource,
  medicationCadenceResponse,
  medicationComplianceResponse,
  medicationComplianceSummaryEntry,
  scheduleRevisionResource,
  scheduleRevisionListResponse,
  medicationExtractRequest,
  medicationListLayoutPutBody,
  medicationListLayoutResult,
  doseHistoryQuery,
  doseHistoryResponse,
  medicationIntakeImportJobStatusResponse,
  medicationDoseHistoryImportResponse,
} from "./schemas";

// ── Bulk intake backfill (iOS SyncMode) — mirrors the route's
// `bulkPayloadSchema` / `bulkEntrySchema` and the batch-envelope response.
const bulkIntakeEntry = z
  .object({
    medicationId: z.string().min(1),
    scheduledFor: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("ISO instant; defaults to `takenAt` then now() when omitted."),
    takenAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("ISO instant of the take; omit + `skipped:false` = pending."),
    skipped: z.boolean().optional().describe("Default false."),
    idempotencyKey: z.string().min(1).max(128).optional(),
    injectionSite: injectionSiteEnum
      .optional()
      .describe(
        "Per-entry injection site; a disallowed site marks THIS entry skipped without failing the batch.",
      ),
    forceSlotInstant: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Pin a taken entry onto a named real scheduled slot; ignored on non-taken entries.",
      ),
    doseTaken: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .optional()
      .describe("Per-entry dose override; persisted only on a taken entry."),
    source: z
      .literal("APPLE_HEALTH")
      .optional()
      .describe(
        "v1.28 — Apple Health dose-event import. Must be supplied together with `externalId`, and may only target a medication mirrored from Apple Health (else the whole batch 422s).",
      ),
    externalId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "The HealthKit dose-event UUID. Drives the idempotent re-sync dedup (first-write-wins per Apple dose). Must be stable across app restarts — an object description or memory address (`<Class: 0x…>`, `0x12ab34cd`) is a new value on every launch; such an entry is `skipped` with reason `unstable_external_id` while the rest of the batch still lands.",
      ),
  })
  .meta({
    id: "BulkMedicationIntakeEntry",
    description:
      "One bulk medication-intake entry. `source` + `externalId` are both-or-neither.",
  });

const bulkIntakePayload = z
  .object({
    entries: z.array(bulkIntakeEntry).min(1).max(500),
  })
  .meta({
    id: "BulkMedicationIntakeRequest",
    description:
      "iOS SyncMode bulk intake backfill. 1–500 entries per call; idempotent via `Idempotency-Key` and per-entry `idempotencyKey` / `externalId`.",
  });

const bulkIntakeEntryResult = z
  .object({
    index: z.number().int().nonnegative(),
    status: z
      .enum(["inserted", "updated", "duplicate", "skipped"])
      .describe(
        "`inserted`/`updated`/`duplicate` — the row landed (advance the cursor). `skipped` — not stored; see `reason`.",
      ),
    reason: z.string().optional(),
    id: z.string().optional().describe("The landed row id (absent on skips)."),
  })
  .meta({ id: "BulkMedicationIntakeEntryResult" });

const bulkIntakeResponse = z
  .object({
    processed: z.number().int().nonnegative(),
    inserted: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    skipped: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    ),
    entries: z.array(bulkIntakeEntryResult),
  })
  .meta({ id: "BulkMedicationIntakeResponse" });

// Two paths poll the identical job-status projection — the per-medication
// import and the account-wide dose-history import (which narrows to a
// `medicationId: null` job through the SAME `readMedicationIntakeImportJob`
// helper). Building the envelope once and reusing the object keeps both
// `200` responses pointing at one `MedicationIntakeImportJobStatusEnvelope`
// component instead of two separately-generated copies.
const medicationIntakeImportJobStatusEnvelope = dataEnvelope(
  medicationIntakeImportJobStatusResponse,
  "MedicationIntakeImportJobStatusEnvelope",
);

export const medicationPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/medications/intake/bulk": {
    post: {
      tags: ["Medications"],
      summary: "Bulk medication-intake backfill (iOS SyncMode)",
      description:
        "Up to 500 intake entries per call, mirroring the mood-entries bulk envelope so the iOS sync engine reuses one retry/cursor path. Idempotent via the `Idempotency-Key` header plus per-entry `idempotencyKey` / `externalId`. Per-entry status (`inserted` / `updated` / `duplicate` / `skipped`) lets the client advance its cursor. Rate-limited 60/min/user. An `APPLE_HEALTH` entry must carry `externalId` and target a medication mirrored from Apple Health, else the whole batch 422s (`meta.errorCode = medications.intake.bulk.apple_health_not_mirrored`); an over-size batch 422s (`medications.intake.bulk.too_large`); a malformed body 422s (`medications.intake.bulk.invalid`).",
      requestBody: {
        required: true,
        content: { "application/json": { schema: bulkIntakePayload } },
      },
      responses: {
        "200": {
          description: "Batch processed (always 200 on a well-formed body).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                bulkIntakeResponse,
                "BulkMedicationIntakeResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications": {
    get: {
      tags: ["Medications"],
      summary: "List medications for the calling user",
      description:
        "Returns every medication owned by the caller (active + paused), ordered by `createdAt DESC`. Each row carries its nested `schedules`, the joined clinical `category`, the latest non-skipped `lastTakenAt`, and the count of today's actioned intake events (`todayEventCount`). The response is cached server-side for 60 s per user; writes flush the cache.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Medication list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(medicationListEntry),
                "ListMedicationsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Medications"],
      summary: "Create a medication with at least one schedule",
      description:
        "Validates the body against `CreateMedicationRequest`, applies the v1.5 cross-field invariants (one-shot consistency, recurring default `FREQ=DAILY`, `timesOfDay` dual-write), and creates the medication + its schedules in a single Prisma write. Audits as `medication.create`. v1.28 — a mirror create (`externalSource` + `externalId`) re-posting a pair the caller already holds returns the existing medication with 200 instead of a duplicate. v1.32.25 — a NEW mirror create is refused with 422 (`meta.errorCode = medications.mirror.limit_exceeded`) once the caller already holds 30 medications mirrored from the same external source; an idempotent re-post of a medication already mirrored is unaffected, and native creates are never gated.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createMedicationSchema } },
      },
      responses: {
        ...recordRefusal(),
        "201": {
          description: "Created medication with its schedules.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "CreateMedicationResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/layout": {
    get: {
      tags: ["Medications"],
      summary: "Read the calling user's medications list presentation",
      description:
        "Returns the per-user /medications presentation (card/table view + manual order) plus the optimistic-concurrency `updatedAt` token. Falls back to the defaults (cards, empty order) when the user has not customised it. Mirrors the insights-layout contract.",
      responses: {
        ...recordRefusal(),
        "200": {
          description:
            "The resolved presentation (custom or default) plus its token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationListLayoutResult,
                "MedicationListLayoutResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Medications"],
      summary: "Update the calling user's medications list presentation",
      description:
        "Field-scoped update: `view` and `order` are each optional, and whichever the body omits is preserved from the stored blob — a view toggle can never wipe the manual order and vice versa. The normalised presentation plus the advanced `updatedAt` token is returned. Optimistic concurrency (v1.32.21): send `baseUpdatedAt` (the token from a prior read) and the write 409s if the stored blob changed since; omit it for the legacy unconditional write. Invalid bodies return the multi-issue 422 envelope.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: medicationListLayoutPutBody },
        },
      },
      responses: {
        "200": {
          description:
            "Presentation saved; the normalised blob plus the advanced token is echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationListLayoutResult,
                "MedicationListLayoutSaved",
              ),
            },
          },
        },
        ...conflictResponse409(
          "Medications layout",
          "medication_layout_conflict",
        ),
        ...stdResponses,
        ...invalidBaseTokenResponse,
      },
    },
    delete: {
      tags: ["Medications"],
      summary: "Reset the calling user's medications list presentation",
      description:
        "Clears the persisted presentation and returns the defaults (cards, empty order). Idempotent.",
      responses: {
        "200": {
          description: "Presentation reset; the defaults are returned.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationListLayoutResult,
                "MedicationListLayoutReset",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}": {
    get: {
      tags: ["Medications"],
      summary: "Fetch a single medication",
      description:
        "Returns the medication + its schedules + the joined `category`. Cross-user rows surface as 404 (existence channel sealed).",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Medication detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "GetMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Medications"],
      summary: "Replace a medication (partial fields)",
      description:
        "Every field on the body is optional; omitted fields are left untouched. Supplying `schedules` REPLACES the medication's full schedule list (the route deletes existing rows before re-creating). Flipping `active` to false stamps `pausedAt`; flipping back to true clears it. v1.5 invariants on the `schedules` array match `POST /api/medications`. Audits as `medication.update`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateMedicationSchema } },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Updated medication.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "UpdateMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Medications"],
      summary: "Delete a medication",
      description:
        "Cascades to the medication's schedules, intake events, dose changes, inventory rows, and side-effect logs. Revokes every API token scoped to `medication:<id>:ingest`. Audits as `medication.delete`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/intake": {
    post: {
      tags: ["Medications"],
      summary: "Log an intake event for a medication",
      description:
        "Records a taken or skipped dose. Idempotent via the `Idempotency-Key` header AND the optional `idempotencyKey` body field (the route walks both paths); a re-post inside the 60 s server-side dedup window returns the original event. Non-skipped intakes auto-decrement pen inventory (best-effort), refresh the per-day compliance rollup, and — for `oneShot:true` medications — flip `active` to false.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: { "application/json": { schema: intakeSchema } },
      },
      responses: {
        ...recordRefusal(),
        "201": {
          description: "Intake event created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationIntakeEventResource,
                "CreateMedicationIntakeResponse",
              ),
            },
          },
        },
        "200": {
          description:
            "Idempotent replay — the original event is returned without creating a new row.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationIntakeEventResource,
                "ReplayMedicationIntakeResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/inventory": {
    get: {
      tags: ["Medications"],
      summary: "List a medication's supply containers",
      description:
        "Returns every inventory item (all states) for the medication, ordered by state, then `expiresAt`, then `createdAt`. Items count UNITS; divide by the medication's `unitsPerDose` for dose-level figures. v1.19.0 (iOS#25) — also returns a server-computed `summary` (the canonical {`unitsRemaining`, `unitsTotal`, `dosesRemaining`, `dosesTotal`, `expiredUnits`}); clients render it directly rather than re-deriving the Bestand headline, so web and iOS agree.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Inventory item list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  items: z.array(medicationInventoryItemResource),
                  summary: medicationSupplySummaryResource,
                  meta: z.object({ total: z.number().int().nonnegative() }),
                }),
                "ListMedicationInventoryResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Medications"],
      summary: "Register a new supply container",
      description:
        "Creates an ACTIVE inventory item with `unitsRemaining = unitsTotal`. The request's `unitsTotal` field carries UNITS (1–1000). Rate-limited 30/min/user. Audits as `medication.inventory.create`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: createInventoryItemSchema },
        },
      },
      responses: {
        ...recordRefusal(),
        "201": {
          description: "Created inventory item.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationInventoryItemResource,
                "CreateMedicationInventoryItemResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/inventory/{itemId}": {
    patch: {
      tags: ["Medications"],
      summary: "Mutate a supply container",
      description:
        "Per-item operations: manual first-use (`markAsFirstUseAt`), used-up override (`markAsUsedUp`), printed-expiry correction, absolute remaining-unit correction (`unitsRemaining`, clamped to the item's capacity), notes. The canonical state machine re-derives the state after every mutation. Audits as `medication.inventory.update`.",
      requestParams: {
        path: z.object({ id: z.string(), itemId: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: updateInventoryItemSchema },
        },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Updated inventory item.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationInventoryItemResource,
                "UpdateMedicationInventoryItemResponse",
              ),
            },
          },
        },
        "404": {
          description:
            "Inventory item not found (or owned by another user / medication).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Medications"],
      summary: "Delete a supply container",
      description:
        "Hard-deletes the inventory item. The audit log captures the before-state (`medication.inventory.delete`) so a row can be reconstructed if needed. Consumption stamps on intake events that reference the item stay in place; a later restore skips the missing container.",
      requestParams: {
        path: z.object({ id: z.string(), itemId: z.string() }),
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ id: z.string(), deleted: z.boolean() }),
                "DeleteMedicationInventoryItemResponse",
              ),
            },
          },
        },
        "404": {
          description:
            "Inventory item not found (or owned by another user / medication).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/extract": {
    post: {
      tags: ["Medications"],
      summary:
        "Extract scheduling fields from a free-text medication description",
      description:
        "Runs the user's free-text description through the Coach provider chain and returns a citation-guarded partial payload the wizard merges onto whatever the user already typed. `name` and `dose` are dropped when not substring-matched in the original text so the wizard cannot land a hallucinated brand or dose. `cadenceKind` / `doseUnit` / `weekdays` are closed enums; numeric fields are clamped. Rate-limited 10 requests / 5 minutes / user, gated against the daily Coach token budget.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: medicationExtractRequest },
        },
      },
      responses: {
        "200": {
          description: "Citation-guarded partial extraction.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationExtractionSchema,
                "MedicationExtractResponse",
              ),
            },
          },
        },
        "502": {
          description:
            "Upstream provider returned an empty, unparseable, or off-schema reply.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description:
            "No AI provider configured for the calling user (or operator).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/cadence": {
    get: {
      tags: ["Medications"],
      summary: "Cadence + compliance read for a medication",
      description:
        "Returns the expected-vs-actual dose timeline for the requested window plus the four compliance chip values that drive the detail-page section. Pure computation — no writes. Day boundaries are resolved in the user's IANA timezone so a Tokyo user and a Berlin user see the same chips for the same medication. The `days` query parameter caps at 180.",
      requestParams: {
        path: z.object({ id: z.string() }),
        query: z.object({
          days: z.coerce
            .number()
            .int()
            .min(1)
            .max(180)
            .optional()
            .describe("Window size in days (default 30, max 180)."),
        }),
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Cadence response.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationCadenceResponse,
                "GetMedicationCadenceResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/compliance": {
    get: {
      tags: ["Medications"],
      summary: "Batched adherence read for every medication of the caller",
      description:
        "Returns one compact adherence row per medication the caller owns (active + paused), ordered by `createdAt DESC` — the single round trip the medication cards consume instead of fanning out one `/api/medications/{id}/compliance` request per card. Each row carries the 7-/30-day summaries and the cadence-scaled display block; the per-day grid stays on the per-medication endpoint. Pure computation — no writes. Served through the same per-medication server cache as the per-id read, so the two endpoints warm each other.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "One adherence row per medication.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(medicationComplianceSummaryEntry),
                "ListMedicationComplianceResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/compliance": {
    get: {
      tags: ["Medications"],
      summary: "Adherence read for a medication",
      description:
        "Returns the 7- and 30-day adherence summaries, the per-day compliance grid for the history glyph track, and the two-row display block. Pure computation — no writes. Day boundaries are resolved in the user's IANA timezone, and the expected-dose denominator is cadence-aware (RRULE / rolling / one-shot / PRN / cyclic) and clamped to the medication's `createdAt`. Read `compliance30` for the headline 30-day taken-vs-expected percentage; build the per-day glyph track from `dailyCompliance` (draw a cell only where `due === true`).",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Compliance response.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationComplianceResponse,
                "GetMedicationComplianceResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/efficacy": {
    get: {
      tags: ["Medications"],
      summary: 'Efficacy view for a medication ("Wirkung")',
      description:
        "Returns the resolved, strictly-descriptive efficacy DTO: the outcome metric(s)/lab(s) the medication's class targets, the target series with start/dose-change/pause markers, a before/after-start comparison, the cadence-aware adherence lane, an optional conservative level-shift note, the data-floor state, and the retarget options. Association-only — there is no verdict / score field. `eligible:false` (with `reason`) marks a one-shot or no-target medication whose tab is hidden.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Efficacy view.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationEfficacyResponseSchema,
                "GetMedicationEfficacyResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/efficacy/target": {
    put: {
      tags: ["Medications"],
      summary: "Set or clear the efficacy-target override",
      description:
        "Persists the user's explicit efficacy target for a medication (the only thing the view stores; everything else is derived each read). Pin exactly one of `measurementType` / `biomarkerId`, or pass `clear:true` to revert to the derived target.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: efficacyTargetOverrideSchema },
        },
      },
      responses: {
        "200": {
          description: "Override set or cleared.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  ok: z.boolean().optional(),
                  cleared: z.boolean().optional(),
                }),
                "SetMedicationEfficacyTargetResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication or biomarker not found.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/dose-history": {
    get: {
      tags: ["Medications"],
      summary: "Per-slot dose-history ledger (Verlauf tab)",
      description:
        "Returns the full per-slot ledger for the medication over [from, to]: every expected slot with a status (taken on-time / taken late / skipped / missed / upcoming) plus every off-schedule intake tagged ad-hoc. Built from the SAME band minter + `reconstructDoseHistory` the compliance % consumes, so the history view and the rate can never disagree. v1.32.8 (iOS #64) surfaces `intake.source` so a client can label how each dose was recorded. Ownership-scoped; rate-limited 60/min/user; reads only non-deleted rows. Auth via cookie or Bearer.",
      requestParams: {
        path: z.object({ id: z.string() }),
        query: doseHistoryQuery,
      },
      responses: {
        "200": {
          description: "Dose-history ledger.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                doseHistoryResponse,
                "GetDoseHistoryResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/schedule-revisions": {
    get: {
      tags: ["Medications"],
      summary: "List a medication's archived schedule eras",
      description:
        "Returns every archived schedule era (newest first) plus `currentSince`, the instant the live plan took over. The dose-history ledger and compliance tallies already mint past days against these eras; this read powers the Zeitplan-tab history timeline.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Era list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                scheduleRevisionListResponse,
                "ListScheduleRevisionsResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Medications"],
      summary: "Append a manual schedule era (pre-tracking history)",
      description:
        "Records that the medication dosed at the given daily times during `[validFrom, validUntil)` — history from before the schedule was edited in the app. The era must end at or before the start of the live plan and must not overlap an existing era; violations return 422. The snapshot is shaped exactly like a write-path archive (`FREQ=DAILY`, window pulled to the min/max of the times), so every historical surface reads it transparently. Audits as `medication.schedule_revision.created`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: scheduleRevisionCreateSchema },
        },
      },
      responses: {
        ...recordRefusal(),
        "201": {
          description: "Manual era created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                scheduleRevisionResource,
                "CreateScheduleRevisionResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/schedule-revisions/{revisionId}": {
    patch: {
      tags: ["Medications"],
      summary: "Correct a recorded schedule era",
      description:
        "Replaces an era's bounds and daily times. A `MANUAL` era updates in place; an `ARCHIVED` era stays as the immutable audit record and the correction is minted as a superseding `MANUAL` revision that takes its place in every historical surface (the response carries the correction's id). Validation mirrors the sibling POST: the era must end at or before the start of the live plan and must not overlap another active era; violations return 422. An era that has already been corrected refuses with 409. Audits as `medication.schedule_revision.updated`.",
      requestParams: {
        path: z.object({ id: z.string(), revisionId: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: scheduleRevisionUpdateSchema },
        },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Era corrected.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                scheduleRevisionResource,
                "UpdateScheduleRevisionResponse",
              ),
            },
          },
        },
        "404": {
          description:
            "Medication or revision not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The revision has already been superseded by a correction.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Medications"],
      summary: "Delete a manually added schedule era",
      description:
        "Removes a `MANUAL` era — one appended through the sibling POST, or a correction minted by PATCH (deleting a correction restores the archived original it superseded). Write-path archives (`source: ARCHIVED`) are immutable history and refuse with 409. Audits as `medication.schedule_revision.deleted`.",
      requestParams: {
        path: z.object({ id: z.string(), revisionId: z.string() }),
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteScheduleRevisionResponse",
              ),
            },
          },
        },
        "404": {
          description:
            "Medication or revision not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The revision is a write-path archive (`ARCHIVED`) and cannot be deleted.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/intake/dose-history-import": {
    post: {
      tags: ["Medications"],
      summary: "Import a dose history exported from another medication tracker",
      description:
        "Reads a ten-column CSV export covering a whole regimen (multiple medications in one file), matching each row against the caller's existing medications by name — a medication is NEVER created from an import file. `text/csv` carries the actual dose history (`Date`/`Scheduled Date` in separate columns, mapped onto `takenAt`/`scheduledFor`). `application/json` is accepted at the content-type check but the documented JSON export shape always refuses at 422 (`json_carries_no_intake_time`): it has no field for when a dose was actually taken, and inferring one from the scheduled time would manufacture an on-time history the file never claimed. Body capped at 16 MB and 30 000 importable rows. `?dryRun=1` parses, matches, and returns the file verdict WITHOUT writing. A real submission queues the write onto the same background job the per-medication import uses (chunked, heartbeated, resumable) and returns 202 with a `statusUrl` to poll. Shares the 5/hour `import:` rate bucket with every other bulk import surface. Auth via cookie or Bearer.",
      parameters: [
        {
          name: "dryRun",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["1", "true"] },
          description:
            "When `1` / `true`, parse + match + return the file verdict without queuing a write.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "text/csv": { schema: { type: "string" } },
          "application/json": { schema: { type: "string" } },
        },
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Dry-run verdict (nothing written).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDoseHistoryImportResponse,
                "MedicationDoseHistoryImportDryRunEnvelope",
              ),
            },
          },
        },
        "202": {
          description: "Import queued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDoseHistoryImportResponse,
                "MedicationDoseHistoryImportQueuedEnvelope",
              ),
            },
          },
        },
        "409": {
          description: "A dose-history import is already in progress.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "File exceeds the 16 MB limit.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "Content-Type must be text/csv or application/json.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description: "Background worker is not available.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The file could not be read (see `MedicationDoseHistoryImportFatalReason` for the closed `errorCode` set), or it holds more than 30 000 importable rows (`errorCode: too_many_rows`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/medications/{id}/intake/import/{jobId}/status": {
    get: {
      tags: ["Medications"],
      summary: "Poll a per-medication intake-import job",
      description:
        "Returns the queued/running/finished state of a per-medication intake-import job, scoped to the caller's own medication. A job created by the account-wide dose-history import (which carries no `medicationId`) never resolves through this path — poll its own `statusUrl` instead. v1.33.0 widened `result.skipReasons[].reason` / `progress.skipDetails[].reason` to the full 16-value `MedicationImportSkipReason` set. A foreign or unknown job/medication id is sealed as 404. Auth via cookie or Bearer.",
      requestParams: {
        path: z.object({ id: z.string(), jobId: z.string() }),
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Current job status.",
          content: {
            "application/json": {
              schema: medicationIntakeImportJobStatusEnvelope,
            },
          },
        },
        "404": {
          description:
            "No such job for this medication (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/intake/dose-history-import/{jobId}/status": {
    get: {
      tags: ["Medications"],
      summary: "Poll an account-wide dose-history-import job",
      description:
        "Returns the queued/running/finished state of a dose-history-import job created by `POST /api/medications/intake/dose-history-import` — the `statusUrl` that create response carries. Identical response projection to the per-medication `/api/medications/{id}/intake/import/{jobId}/status` (both read through the same `readMedicationIntakeImportJob` helper); this path narrows to the account-wide job (`medicationId: null`), so a per-medication job id 404s here and vice versa. A foreign or unknown job id is sealed as 404. Auth via cookie or Bearer.",
      requestParams: {
        path: z.object({ jobId: z.string() }),
      },
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Current job status.",
          content: {
            "application/json": {
              schema: medicationIntakeImportJobStatusEnvelope,
            },
          },
        },
        "404": {
          description:
            "No such job for this account (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
