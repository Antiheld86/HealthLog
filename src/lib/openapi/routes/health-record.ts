/**
 * OpenAPI route table — health-record export, clinician share links, FHIR R4 read surface.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { exportSelectionSchema } from "@/lib/validations/health-record-export";
import {
  createShareLinkSchema,
  unlockShareLinkSchema,
} from "@/lib/validations/clinician-share-link";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

// v1.11.0 — clinician share-link owner-facing summary (never the raw token).
const shareLinkSummary = z.object({
  id: z.string(),
  label: z.string(),
  rangeStart: z.string(),
  rangeEnd: z.string().nullable(),
  // v1.18.7 — whether a passphrase second factor guards this link. Always true
  // for links created on v1.18.7+; false only for legacy links.
  protected: z.boolean(),
  // v1.28 — how many documents this share carries. Never the ids, never the
  // bytes; the share serve route is the only decrypt path.
  documentCount: z.number(),
  expiresAt: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  lastAccessAt: z.string().nullable(),
  accessCount: z.number(),
  active: z.boolean(),
});

const shareLinkCreatedResponse = shareLinkSummary.extend({
  token: z
    .string()
    .describe("Raw `hls_` token — returned ONCE and unrecoverable thereafter."),
  // v1.18.7 — passphrase second factor + QR deep link, all returned ONCE.
  passphrase: z
    .string()
    .describe(
      "Raw passphrase second factor — returned ONCE; stored only as an HMAC hash, unrecoverable.",
    ),
  shareUrl: z.string().describe("Absolute `/c/<token>` URL (no passphrase)."),
  qrUrl: z
    .string()
    .describe(
      "Absolute share URL with the passphrase in the URL FRAGMENT (`#k=<passphrase>`). Encode this as the QR payload; the fragment is never sent to the server.",
    ),
});

const shareLinkListResponse = z.object({
  shareLinks: z.array(shareLinkSummary),
});

const shareLinkRevokedResponse = z.object({
  id: z.string(),
  revoked: z.boolean(),
});

// v1.18.7 — public passphrase-gate verify result.
const shareLinkUnlockResponse = z.object({
  unlocked: z.literal(true),
});

export const healthRecordPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/export/health-record": {
    post: {
      tags: ["Export"],
      summary: "Generate a health-record export (PDF / FHIR / package)",
      description:
        "v1.7.0 flagship export. Returns the doctor-handover artefact in the requested `format`: `pdf` → application/pdf, `fhir` → application/fhir+json (HL7 FHIR R4 document Bundle), `package` → application/zip (PDF + FHIR + README). Auth via cookie or Bearer; shared `export:<userId>` rate bucket (10/h). Strict validation: unknown keys 422.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: exportSelectionSchema },
        },
      },
      responses: {
        "200": {
          description:
            "Export generated. Content-Type varies by `format`: application/pdf, application/fhir+json, or application/zip.",
          content: {
            "application/pdf": {
              schema: z.string().meta({ format: "binary" }),
            },
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
            "application/zip": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/share-links": {
    post: {
      tags: ["Export"],
      summary: "Create a clinician share link (v1.11.0)",
      description:
        "Owner-only. Mints an `hls_` token (192-bit), stores only its HMAC hash, and returns the raw token EXACTLY ONCE in the response. v1.18.7 also mints a passphrase second factor (returned once as `passphrase`, with `shareUrl` and a `qrUrl` carrying the passphrase in the URL fragment); a leaked URL without the passphrase cannot open the record. Every scope column (window, sections, FHIR resource types, API toggle) is frozen write-once. v1.28 accepts an optional `documentIds` array (bounded ≤50): each id is validated as the caller's own live document and frozen onto the link at create (a foreign/deleted id → 422); the summary DTO then reports `documentCount`. A documents-only share (empty report sections + non-empty `documentIds`) is valid. `expiresAt` is required and capped at 90 days. Auth via cookie or Bearer; rate-limited (`share-link:<userId>`, 20/h). Strict: unknown keys 422.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: createShareLinkSchema },
        },
      },
      responses: {
        "201": {
          description:
            "Share link created. `token` carries the raw `hls_` value and is unrecoverable after this response.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                shareLinkCreatedResponse,
                "ShareLinkCreated",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    get: {
      tags: ["Export"],
      summary: "List own clinician share links (v1.11.0)",
      description:
        "Owner-only. Returns the caller's own share links (never the raw token — it is unrecoverable after creation). Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Share links owned by the caller.",
          content: {
            "application/json": {
              schema: dataEnvelope(shareLinkListResponse, "ShareLinkList"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/share-links/{id}": {
    delete: {
      tags: ["Export"],
      summary: "Revoke a clinician share link (v1.11.0)",
      description:
        "Owner-only. Sets `revokedAt` on the caller's own link. A cross-user or unknown id is sealed as 404. Auth via cookie or Bearer; rate-limited.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Link revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                shareLinkRevokedResponse,
                "ShareLinkRevoked",
              ),
            },
          },
        },
        "404": {
          description: "Link not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/c/{token}/unlock": {
    post: {
      tags: ["Export"],
      summary: "Verify a share-link passphrase (v1.18.7, public)",
      description:
        "Anonymous, no-session passphrase gate for a protected share link. The raw path token plus the submitted passphrase are the only credentials. On success the server sets a short-lived (30 min), token-scoped, httpOnly cookie so `/c/<token>` renders the record. Rate-limited (`share-unlock:<tokenHash>:<ip>`); every failure class (bad token, no passphrase set, wrong passphrase) answers one blunt 401.",
      requestParams: { path: z.object({ token: z.string() }) },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: unlockShareLinkSchema },
        },
      },
      responses: {
        "200": {
          description:
            "Passphrase accepted; short-lived token-scoped unlock cookie set.",
          content: {
            "application/json": {
              schema: dataEnvelope(shareLinkUnlockResponse, "ShareLinkUnlock"),
            },
          },
        },
        // Spread the standard responses first, then override 401 with the
        // share-specific blunt-reject description.
        ...stdResponses,
        "401": {
          description: "Invalid passphrase (blunt — no failure detail leaked).",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/c/{token}/d/{id}": {
    get: {
      tags: ["Export"],
      summary: "Serve a shared document blob (v1.28, public)",
      description:
        "Anonymous, no-session share-scoped document serve route. The raw `hls_` share token in the path is the ONLY credential — never a session; it never elevates a normal authed route. Serves ONLY a document id present in the link's frozen `documentIds` set (a guessed / foreign / soft-deleted id → flat 404). A passphrase-protected link additionally requires the short-lived, token-scoped unlock cookie; revocation and expiry collapse to the same flat 404. The serving-class posture is identical to the owner `/api/documents/inbound/{id}/original` route: Class A (PDF/JPEG/PNG/WebP/GIF) inline with its true type, everything else `application/octet-stream` + `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`; `Cache-Control: private, no-store`. Images (JPEG/PNG/WebP) are EXIF/XMP/GPS-stripped at egress (the stored original is untouched); PDF/TIFF/HEIC/Office metadata passes through. Per-link rate-limited.",
      requestParams: {
        path: z.object({
          token: z.string().describe("Raw `hls_` share token."),
          id: z.string().describe("A document id on the link's frozen set."),
        }),
      },
      responses: {
        "200": {
          description:
            "The document bytes. Content-Type is the true stored type for Class A (inline) or `application/octet-stream` for Class B (attachment).",
          content: {
            "application/octet-stream": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        "404": {
          description:
            "Flat 404 for every miss class (unknown/revoked/expired token, locked passphrase gate, or an id not on the frozen set).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description: "Per-link serve rate limit exceeded.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/fhir/metadata": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 CapabilityStatement (v1.11.0)",
      description:
        "Read-only FHIR R4 capability statement for the REST face. Declares the served resource types (Patient, Observation, MedicationStatement, MedicationAdministration), the `$everything` operation, and the `application/fhir+json` format. Auth: `fhir:read` scope (cookie sessions also pass).",
      responses: {
        "200": {
          description: "CapabilityStatement (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/Patient": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 Patient search (v1.11.0)",
      description:
        "Read-only `searchset` Bundle of the caller's own Patient resource. Auth: `fhir:read` scope. Offset paging via `_count` (clamped ≤200) / `_offset`. `userId` is narrowed from auth.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/Observation": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 Observation search (v1.11.0)",
      description:
        "Read-only `searchset` Bundle of the caller's own Observations (vitals / activity / lab / survey). Auth: `fhir:read` scope. Offset paging via `_count` (clamped ≤200) / `_offset`.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/MedicationStatement": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 MedicationStatement search (v1.11.0)",
      description:
        "Read-only `searchset` Bundle of the caller's own active-medication statements. Auth: `fhir:read` scope. Offset paging via `_count` (≤200) / `_offset`.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/MedicationAdministration": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 MedicationAdministration search (v1.11.0)",
      description:
        "Read-only `searchset` Bundle of the caller's own acted intakes (completed / not-done). Auth: `fhir:read` scope. Offset paging via `_count` (≤200) / `_offset`.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/$everything": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 $everything (v1.11.0)",
      description:
        "Read-only `$everything` operation: every resource in the caller's own record (Patient, Coverage, Observations, MedicationStatements, MedicationAdministrations) in one `searchset` Bundle. Auth: `fhir:read` scope. Offset paging via `_count` (≤200) / `_offset`.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
