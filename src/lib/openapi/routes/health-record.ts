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
import {
  dataEnvelope,
  errorEnvelope,
  recordRefusal,
  stdResponses,
} from "./shared";

// The two request bodies this module publishes. `.meta()` CLONES in Zod 4
// rather than annotating in place, so the returned schema has to be captured
// and referenced: a bare `schema.meta({...})` statement registers nothing and
// the component id it names never reaches the emitted document. Both
// annotations used to sit in `./coach`, which imported the schemas for no
// other reason and never referenced them; the two operations that DO send
// these bodies are both here.
//
// v1.7.0 — health-record export selection. Strict shape: unknown keys
// (including any attempt to smuggle a userId) 422 via returnAllZodIssues.
// v1.11.0 — clinician share-link create payload. Strict; no `userId` field
// (the owner is always narrowed from the session/Bearer). `expiresAt` is
// required and capped at SHARE_LINK_MAX_DAYS; the scope columns are frozen
// write-once at creation.
const createShareLinkRequest = createShareLinkSchema.meta({
  id: "CreateShareLinkRequest",
  description:
    "v1.11.0 — owner request to mint a clinician share link to their own health record. `expiresAt` is required (absolute ISO instant) and capped at 90 days. `rangeStart`/`rangeEnd` freeze the reporting window (rangeEnd null = rolling). `selection` freezes which record leaves the link may serve, and omitting it means an empty scope rather than a default one. The `INSURANCE` leaf is refused outright (422, naming it): the share view has never decrypted the insurance number, and refusing it here makes that structural. `documentIds` freezes the documents the link carries; `documentOnly` mints a share that serves those documents and no record scope at all. A share link serves the rendered page, the documents frozen onto it, and the same record as a PDF or FHIR Bundle download under the token (`/c/{token}/report.pdf`, `/c/{token}/fhir`) — all behind the same gate and the same frozen selection. A share token is not a Bearer credential and reaches no other route. Strict: unknown keys 422.",
});

const healthRecordExportRequest = exportSelectionSchema.meta({
  id: "HealthRecordExportRequest",
  description:
    "v1.7.0 — health-record / doctor-handover export selection. `format` picks PDF, FHIR R4 document Bundle, or a combined zip package. `selection` is REQUIRED and carries the leaf inclusion list — membership is inclusion, absence is exclusion, and there is no server-side default; the retired grouped `sections` shape is a 422. No `userId` field — the user is always narrowed from the session/Bearer. The route is strict: unknown keys 422.",
});

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
  // v1.28.13 — the frozen documents-only flag, written once at creation and
  // never updated. True means the link carries NO report scope at all (the
  // create route forces `selection` empty server-side even if the body sent
  // one) and the share view renders only the frozen document set, never a
  // health-record section.
  documentOnly: z.boolean(),
  // Whether this link's frozen scope predates the selection model. Every such
  // link was revoked on upgrade; the sharing list surfaces this so the owner
  // knows to re-mint rather than wondering why a working link stopped.
  needsReselection: z.boolean(),
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
        "Returns the doctor-handover artefact in the requested `format`: `pdf` → application/pdf, `fhir` → application/fhir+json (HL7 FHIR R4 document Bundle), `package` → application/zip (PDF + FHIR + README). `selection` is REQUIRED and carries the leaf inclusion list — membership is inclusion, absence is exclusion, and there is no server-side default. An unknown leaf id is a 422 that names it; the retired grouped `sections` shape is a 422 too, because accepting it would mean choosing a scope the caller did not express. Auth via cookie or Bearer; shared `export:<userId>` rate bucket (10/h). Strict validation: unknown keys 422.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: healthRecordExportRequest },
        },
      },
      responses: {
        ...recordRefusal(),
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
        "Owner-only. Mints an `hls_` token (192-bit), stores only its HMAC hash, and returns the raw token EXACTLY ONCE in the response, together with a passphrase second factor and a `qrUrl` carrying that passphrase in the URL fragment; a leaked URL without the passphrase cannot open the record. The window and the `selection` are frozen write-once — there is no widen path. `selection` omitted means an empty scope, not a default one, and the `INSURANCE` leaf is refused with a 422 because the share view never decrypts the insurance number. An optional `documentIds` array (bounded ≤50) is validated as the caller's own live documents and frozen onto the link; a documents-only share (no report scope, non-empty `documentIds`) is valid. `expiresAt` is required and capped at 90 days. Auth via cookie or Bearer; rate-limited (`share-link:<userId>`, 20/h). Strict: unknown keys 422.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: createShareLinkRequest },
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
  "/c/{token}/report.pdf": {
    get: {
      tags: ["Export"],
      summary: "Download a share link's record as the clinical PDF (public)",
      description:
        "Anonymous, no-session download of exactly the record the page at `/c/{token}` renders — the same frozen selection, resolved through the same `selectionFromStoredBlob`, so the file can never be wider than the page above it. The raw `hls_` share token in the path is the ONLY credential; a passphrase-protected link additionally requires the short-lived, token-scoped unlock cookie the browser already holds after unlocking. Unknown / revoked / expired token, a locked gate, and a documents-only link (which carries no record at all) all collapse to the same flat 404. Charts are embedded. Dates print in the OWNER's timezone and clock preference, not the reader's, so a practice west of the record's own zone files a document dated the way the page it came from was. The insurance number is never carried: the `INSURANCE` leaf is refused at share-link creation. Rate-limited per link at 20/h — its own bucket, because generating a report is far more expensive than serving a stored blob.",
      requestParams: {
        path: z.object({
          token: z.string().describe("Raw `hls_` share token."),
        }),
      },
      responses: {
        "200": {
          description:
            "The report as `application/pdf`, `Content-Disposition: attachment`.",
          content: {
            "application/pdf": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        "404": {
          description:
            "Flat 404 for every miss class (unknown / revoked / expired token, locked passphrase gate, or a documents-only link with no record behind it).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description: "Per-link report-download rate limit exceeded (20/h).",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/c/{token}/fhir": {
    get: {
      tags: ["Export"],
      summary:
        "Download a share link's record as an HL7 FHIR R4 Bundle (public)",
      description:
        "The machine-readable twin of `/c/{token}/report.pdf`: the same gate, the same frozen selection, the same flat 404 for every miss class, the same 20/h per-link bucket. Returns an HL7 FHIR R4 **document** Bundle as a download. This is a DOWNLOAD, not a FHIR REST face — a share token authenticates nothing beyond these three routes and `/c/{token}/d/{id}`, and it never becomes a Bearer credential against `/api/fhir/*`. Allergies and family history are deliberately absent from the bundle: they reach the owner's own export through a read this surface does not perform, so the bundle carries the aggregated payload the page renders and nothing beside it. No insurance number, for the same structural reason as the PDF.",
      requestParams: {
        path: z.object({
          token: z.string().describe("Raw `hls_` share token."),
        }),
      },
      responses: {
        "200": {
          description:
            "FHIR R4 document Bundle (`application/fhir+json`), `Content-Disposition: attachment`.",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        "404": {
          description:
            "Flat 404 for every miss class (unknown / revoked / expired token, locked passphrase gate, or a documents-only link with no record behind it).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description: "Per-link report-download rate limit exceeded (20/h).",
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
        "Read-only FHIR R4 capability statement for the REST face. Declares the served resource types (Patient, Coverage, Observation, MedicationStatement, MedicationAdministration), their `read` and `search-type` interactions, the `Patient/$everything` operation, and the `application/fhir+json` format. Every advertised interaction has a route. Auth: `fhir:read` scope (cookie sessions also pass).",
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
  "/api/fhir/Coverage": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 Coverage search",
      description:
        "Read-only `searchset` Bundle of the caller's own Coverage resource, when an insurer is recorded and the insurance leaf is in the saved selection. Auth: `fhir:read` scope. Offset paging via `_count` (clamped ≤200) / `_offset`. `userId` is narrowed from auth.",
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
  "/api/fhir/Patient/{id}": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 Patient read",
      description:
        "Read-only `Patient` by id, out of the caller's own record. An id belonging to someone else is indistinguishable from one that never existed — both answer a `not-found` OperationOutcome. Auth: `fhir:read` scope; `userId` is narrowed from auth.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "The resource (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        "404": {
          description: "OperationOutcome (application/fhir+json).",
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
  "/api/fhir/Coverage/{id}": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 Coverage read",
      description:
        "Read-only `Coverage` by id, out of the caller's own record. An id belonging to someone else is indistinguishable from one that never existed — both answer a `not-found` OperationOutcome. Auth: `fhir:read` scope; `userId` is narrowed from auth.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "The resource (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        "404": {
          description: "OperationOutcome (application/fhir+json).",
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
  "/api/fhir/Observation/{id}": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 Observation read",
      description:
        "Read-only `Observation` by id, out of the caller's own record. An id belonging to someone else is indistinguishable from one that never existed — both answer a `not-found` OperationOutcome. Auth: `fhir:read` scope; `userId` is narrowed from auth.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "The resource (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        "404": {
          description: "OperationOutcome (application/fhir+json).",
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
  "/api/fhir/MedicationStatement/{id}": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 MedicationStatement read",
      description:
        "Read-only `MedicationStatement` by id, out of the caller's own record. An id belonging to someone else is indistinguishable from one that never existed — both answer a `not-found` OperationOutcome. Auth: `fhir:read` scope; `userId` is narrowed from auth.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "The resource (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        "404": {
          description: "OperationOutcome (application/fhir+json).",
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
  "/api/fhir/MedicationAdministration/{id}": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 MedicationAdministration read",
      description:
        "Read-only `MedicationAdministration` by id, out of the caller's own record. An id belonging to someone else is indistinguishable from one that never existed — both answer a `not-found` OperationOutcome. Auth: `fhir:read` scope; `userId` is narrowed from auth.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "The resource (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        "404": {
          description: "OperationOutcome (application/fhir+json).",
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
  "/api/fhir/Patient/$everything": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 $everything (v1.11.0)",
      description:
        "Read-only `Patient/$everything`: every resource the document bundle carries — Composition, Device, Patient, Coverage, Observations (including the cycle ones), MedicationStatements, MedicationAdministrations, Conditions, Encounters, AllergyIntolerances, FamilyMemberHistories and the DiagnosticReport — flattened into one `searchset` Bundle. Scoped to the owner's SAVED report selection; an account that never saved one gets nothing. Auth: `fhir:read` scope. Offset paging via `_count` (≤200) / `_offset`.",
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
