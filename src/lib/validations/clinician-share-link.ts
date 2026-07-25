/**
 * v1.11.0 — clinician share-link lifecycle validation (Epic C, C4).
 *
 * The OWNER creates a time-boxed, scope-frozen share link to their own health
 * record. On create the server mints an `hls_<48 hex>` token (192-bit), stores
 * ONLY its HMAC hash, and returns the raw token exactly once. Every scope
 * column (window, sections) is write-once at creation — there is no
 * widen/update path. `expiresAt` is REQUIRED and capped at
 * `SHARE_LINK_MAX_DAYS` so no link ever lives forever.
 *
 * The `resourceTypes` / `allowFhirApi` request keys are gone. They configured
 * a scoped FHIR face for a share link that was never built, and accepting a
 * scope for a face that does not exist only made the promise look kept. An
 * unknown key is rejected by `.strict()`, so a caller still sending them gets
 * a 422 that names them rather than a silent no-op. The link's record IS
 * reachable in machine form now — as a download at `/c/{token}/fhir`, behind
 * the same unlock the page uses, serving exactly the frozen selection.
 *
 * Strict: `.strict()` rejects unknown keys; there is intentionally no `userId`
 * field (the owner is always narrowed from `requireAuth()`).
 */
import { z } from "zod/v4";

import { reportSelectionSchema } from "@/lib/report-selection/selection";

/**
 * The one leaf a share link may never carry. The share view has never
 * decrypted the insurance number, so refusing it here makes that structural
 * instead of incidental: the create route 422s naming the leaf, and no path
 * exists by which a link could later be widened to include it.
 */
export const SHARE_LINK_FORBIDDEN_LEAVES = ["INSURANCE"] as const;

/** Maximum lifetime of a share link, in days. No never-expiring share. */
export const SHARE_LINK_MAX_DAYS = 90;

const MAX_FUTURE_MS = SHARE_LINK_MAX_DAYS * 24 * 60 * 60 * 1000;

/**
 * v1.28 — the most documents a single share may carry. A share is a hand-picked
 * handover, not a bulk dump; the cap bounds the create-time ownership check and
 * the public view's per-blob fetch fan-out. The ids are validated as the
 * caller's own LIVE documents in the route (a schema can only bound the shape).
 */
export const SHARE_LINK_MAX_DOCUMENTS = 50;

/**
 * Create payload. `expiresAt` is an absolute ISO instant, must be in the
 * future, and at most `SHARE_LINK_MAX_DAYS` ahead of now. `rangeStart` /
 * `rangeEnd` are the frozen reporting window (rangeEnd null = rolling).
 * `documentIds` (optional) is the hand-picked document set, frozen write-once
 * at create; each id is ownership-checked in the route before any row is
 * written. A documents-only share (empty report sections + a non-empty
 * `documentIds`) is valid.
 */
export const createShareLinkSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    rangeStart: z.iso.datetime({ offset: true }),
    rangeEnd: z.iso.datetime({ offset: true }).nullable().optional(),
    selection: reportSelectionSchema.optional(),
    documentIds: z
      .array(z.string().trim().min(1).max(64))
      .max(SHARE_LINK_MAX_DOCUMENTS)
      .optional(),
    /**
     * v1.28.13 — a documents-only share. When true the server FORCES an empty
     * report scope and mints a link that serves ONLY the attached documents —
     * never a health metric. "Share this document" means the document, not the
     * whole record. A documents-only share MUST carry at least one
     * `documentId` (enforced below). Any `selection` sent alongside is ignored
     * server-side so a document link can never widen into a record.
     */
    documentOnly: z.boolean().optional(),
    expiresAt: z.iso
      .datetime({ offset: true })
      .refine((v) => new Date(v).getTime() > Date.now(), {
        message: "expiresAt must be in the future",
      })
      .refine((v) => new Date(v).getTime() <= Date.now() + MAX_FUTURE_MS, {
        message: `expiresAt must be within ${SHARE_LINK_MAX_DAYS} days`,
      }),
  })
  .strict()
  .refine(
    (v) =>
      v.rangeEnd == null ||
      new Date(v.rangeEnd).getTime() >= new Date(v.rangeStart).getTime(),
    { message: "rangeEnd must not precede rangeStart", path: ["rangeEnd"] },
  )
  .refine((v) => !v.documentOnly || (v.documentIds?.length ?? 0) > 0, {
    message: "A documents-only share must carry at least one document",
    path: ["documentIds"],
  });

export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;

/**
 * v1.18.7 — public unlock payload. A clinician submits the passphrase second
 * factor (grouped or bare form). Bounded so a junk body cannot pin the hasher;
 * the route normalises + constant-time compares against the stored hash.
 */
export const unlockShareLinkSchema = z
  .object({
    passphrase: z.string().trim().min(1).max(64),
  })
  .strict();

export type UnlockShareLinkInput = z.infer<typeof unlockShareLinkSchema>;
