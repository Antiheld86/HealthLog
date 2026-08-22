/**
 * OpenAPI route table — generic data export (the legacy plaintext download +
 * the passphrase-encrypted variant).
 *
 * `GET /api/export/full-backup` and the per-type CSV routes still predate the
 * registry and stay out of it. `GET /api/export` no longer does: it is the
 * download the native client and the web settings surface both call, and it
 * was absent from the contract because `pnpm openapi:check` compares the
 * registry against the YAML and never compares the ROUTE TREE against the
 * registry.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { errorEnvelope, stdResponses } from "./shared";

const exportQuery = z
  .object({
    format: z
      .enum(["csv", "json"])
      .optional()
      .describe(
        "Serialisation. Omitted means `json`. Anything else is refused with 422 — the value is NOT clamped to the default.",
      ),
    type: z
      .enum(["measurements", "medications", "intake", "mood", "all"])
      .optional()
      .describe(
        "Which sections to include. Omitted means `all`. Anything else is refused with 422.",
      ),
  })
  .meta({ id: "ExportQuery" });

const exportJsonBody = z
  .object({
    data: z
      .object({
        measurements: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            "Flattened measurement rows, streamed page by page. Present for `type=measurements` and `type=all`.",
          ),
        medications: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            "Flattened medications with their schedules. Present for `type=medications` and `type=all`.",
          ),
        intakeEvents: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            "Flattened intake events (tombstoned rows excluded), newest scheduled slot first. Present for `type=intake` and `type=all`.",
          ),
        moodEntries: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            "Flattened mood entries with the note decrypted. Present for `type=mood` and `type=all`.",
          ),
      })
      .describe(
        "Only the sections the `type` parameter selected are present; the others are absent keys, not empty arrays. Row shapes are the export formatters' flat column sets (the same columns the CSV variant emits as headers), not the API resource shapes — they are deliberately typed loosely here rather than restated, because the formatter is the single source and a restatement would drift.",
      ),
  })
  .meta({
    id: "ExportJsonBody",
    description:
      "The JSON download body. NOTE: this is NOT the standard `{ data, error }` envelope — the route builds the response itself so it can stream, and it carries `data` alone with no `error` key. Do not decode it with the shared envelope decoder.",
  });

const encryptedExportRequest = z
  .object({
    passphrase: z.string().min(12).max(1024).meta({
      description:
        "User-chosen passphrase (>= 12 chars). Derives the archive key via Argon2id; never stored, never logged, no server-side recovery.",
    }),
  })
  .meta({ id: "EncryptedExportRequest" });

export const exportPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/export": {
    get: {
      tags: ["Export"],
      summary: "Download measurements, medications, intake and mood",
      description:
        "The plaintext download. Returns `application/json` or `text/csv` (never the standard response envelope) with a `Content-Disposition: attachment` filename of `healthlog-export-<YYYY-MM-DD>.<ext>`. Measurements stream page by page, so a multi-year account does not buffer its whole history in memory; the other sections are assembled in full first. The CSV variant concatenates the selected sections under `# Measurements` / `# Medications` / `# Intake Events` / `# Mood Entries` headings, so it is a CONCATENATION of tables rather than one table — a single-table CSV parser will choke on it. Mood notes are decrypted into the download; measurement notes ride their exported column. Shares the `export:<userId>` bucket with the encrypted variant (10 per hour) and audits every attempt as `export.download`. Cookie or Bearer auth; the caller is always resolved as themselves, so this download cannot be delegated to a shared record. Not module-gated: a disabled module's rows are still exported, because this is the account's own data leaving on request.",
      requestParams: { query: exportQuery },
      responses: {
        "200": {
          description:
            "The export. `Content-Type` follows `format`; the body is `ExportJsonBody` for JSON and a multi-section CSV document for CSV.",
          content: {
            "application/json": { schema: exportJsonBody },
            "text/csv": { schema: z.string() },
          },
        },
        "422": {
          description:
            "`format` or `type` carried a value outside its enum. The message names the accepted set; nothing is exported. Note that this route validates by hand rather than through Zod, so the response is the single-message error envelope and NOT the multi-issue 422 the rest of the surface returns.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 10 exports in the trailing hour for this account (`export:<userId>`, shared with POST /api/export/encrypted).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "401": stdResponses["401"],
      },
    },
  },
  "/api/export/encrypted": {
    post: {
      tags: ["Export"],
      summary: "Download the full backup as a passphrase-encrypted archive",
      description:
        "v1.23. Same restore-compatible payload as the plaintext full backup, sealed into an `HLX1` archive (Argon2id-derived key + AES-256-GCM) under the supplied `passphrase`. Returns `application/octet-stream` (a `.hlx` file). When the account has a second factor enrolled, the call is step-up gated (`requireFreshMfa`, cookie-only) and returns 401 `auth.stepup.required` without a fresh factor; single-factor accounts use a normal session or Bearer. Shared `export:<userId>` rate bucket (10/h). The passphrase is never stored — a forgotten passphrase makes the archive unrecoverable.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: encryptedExportRequest },
        },
      },
      responses: {
        "200": {
          description:
            "Encrypted archive. `application/octet-stream`; the body is the `HLX1` binary (magic | version | Argon2 params | salt | iv | tag | ciphertext).",
          content: {
            "application/octet-stream": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
