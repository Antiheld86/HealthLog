/**
 * Client-supplied external identifiers — stability floor.
 *
 * Every ingest surface that accepts an `externalId` uses it as one half of
 * a dedup key: `(userId, source, externalId)`, `(userId, externalSource,
 * externalId)`, `(userId, type, source, externalId)`. Re-posting the same
 * triple is idempotent and returns the existing row. That idempotency is
 * only as good as the STABILITY of the identifier — an id that changes
 * between two runs of the same client never matches its own earlier row,
 * so every sync sweep mints a fresh record and the user's history fills
 * with phantom rows that carry no doses, no schedule, no follow-up data.
 *
 * That is not hypothetical. A native client serialised an opaque platform
 * object with the language's default object description and sent the
 * result as `externalId`. The default description of an object with no
 * description contract is `<ClassName: 0xADDRESS>` — a per-allocation
 * MEMORY ADDRESS. A live instance accumulated 23 duplicate medications in
 * a single day, one per sync sweep, each with a different address in its
 * id, and the dose events that should have attached to them resolved
 * through the same rotating string and were never stored at all.
 *
 * This module is the one place that recognises an identifier which CANNOT
 * be a stable identity. It is deliberately narrow: the cost of a false
 * negative is a duplicate row, the cost of a false positive is a
 * legitimate client losing the ability to sync at all. Only shapes that
 * are provably not identities are rejected:
 *
 *   1. `blank`              — empty or whitespace-only after trimming.
 *                             Carries no identity by construction.
 *   2. `pointer_address`    — a bare `0x…` hex value and nothing else.
 *                             A raw address, valid only inside the
 *                             process that printed it.
 *   3. `object_description` — an angle-bracketed description containing
 *                             an `0x…` hex token, e.g. `<Foo: 0x12568db80>`
 *                             or `<Foo: 0x1; bar=2>`. This is the general
 *                             form of a default object description, not a
 *                             match on one platform class: no identity
 *                             format wraps itself in angle brackets around
 *                             a hex pointer.
 *
 * Everything else passes. In particular the identifier shapes this system
 * actually receives all survive:
 *
 *   - UUIDs, upper or lower case, hyphenated or not
 *     (`8AD2A9CB-...`, HealthKit sample UUIDs, SwiftData row ids)
 *   - structured prefix forms
 *     (`stats:HKQuantityTypeIdentifierStepCount:2026-07-25`,
 *      `stats:HKQuantityTypeIdentifierHeartRate:2026-07-25T08:10:00Z`,
 *      `assessment:<id>`, `whoop:<id>`, `oura:<id>`)
 *   - opaque vendor identifiers (numeric ids, base64-ish blobs, hashes —
 *     including a 64-char SHA-256 hex digest, which has no `0x` prefix)
 *   - platform type identifiers (`HKQuantityTypeIdentifierStepCount`)
 *
 * There is deliberately NO rule on length, on the presence of spaces, on
 * character class, or on "looks random enough". Those would reject real
 * vendor identifiers, and a rule that cannot be justified against a shape
 * this system actually receives does not belong here.
 */
import { z } from "zod/v4";

/** The closed set of shapes that cannot be a stable identity. */
export type UnstableExternalIdShape =
  "blank" | "pointer_address" | "object_description";

/**
 * A bare hex pointer and nothing else — `0x12568db80`. Anchored on both
 * ends so an opaque vendor id that merely CONTAINS "0x" is untouched.
 */
const BARE_POINTER = /^0x[0-9a-f]+$/i;

/**
 * An angle-bracketed description carrying a hex pointer, searched
 * anywhere in the value so a client that prefixes its own namespace
 * (`apple:<Foo: 0x1234>`) is caught too. `[^<>]*` keeps the bracket pair
 * adjacent — the token has to be one description, not two unrelated
 * angle brackets spanning half the string.
 */
const POINTER_DESCRIPTION = /<[^<>]*0x[0-9a-f]+[^<>]*>/i;

/**
 * Classify an external identifier. Returns `null` when the value is
 * usable as an identity, or the shape that disqualifies it.
 */
export function classifyExternalId(
  value: string,
): UnstableExternalIdShape | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "blank";
  if (BARE_POINTER.test(trimmed)) return "pointer_address";
  if (POINTER_DESCRIPTION.test(trimmed)) return "object_description";
  return null;
}

/** Convenience predicate over {@link classifyExternalId}. */
export function isStableExternalId(value: string): boolean {
  return classifyExternalId(value) === null;
}

const SHAPE_MESSAGES: Record<UnstableExternalIdShape, string> = {
  blank: "external identifier must not be empty",
  pointer_address:
    "external identifier must be stable across app restarts; received a memory address (0x…), which is a new value on every launch and mints a duplicate record on every sync",
  object_description:
    "external identifier must be stable across app restarts; received an object description (<Class: 0x…>), which embeds a memory address and is a new value on every launch — serialise the identity itself, not the object's description",
};

/** The 422 message a client developer reads. Names the shape received. */
export function unstableExternalIdMessage(
  shape: UnstableExternalIdShape,
): string {
  return SHAPE_MESSAGES[shape];
}

/**
 * Object-level Zod check for a single-entry request schema that carries a
 * top-level `externalId`. Used as `schema.superRefine(assertStableExternalId)`
 * so the refusal rides the standard 422 multi-issue envelope
 * (`returnAllZodIssues` / `sanitiseZodIssues`) with `path: ["externalId"]`
 * instead of a hand-rolled error.
 *
 * Batch / bulk surfaces deliberately do NOT use this: a schema-level
 * refusal fails the whole payload, and one bad row must not stop the other
 * 499 from landing. Those routes call {@link classifyExternalId} per entry
 * and report the entry through their own `skipped` contract.
 */
export function assertStableExternalId(
  value: { externalId?: string | null },
  ctx: z.RefinementCtx,
): void {
  const raw = value.externalId;
  if (typeof raw !== "string") return;
  const shape = classifyExternalId(raw);
  if (shape === null) return;
  ctx.addIssue({
    code: "custom",
    path: ["externalId"],
    message: unstableExternalIdMessage(shape),
  });
}

/**
 * Read a top-level `externalId` off an unparsed request body and classify
 * it. Single-entry routes use this on the 422 path to annotate the wide
 * event with the SHAPE that was refused — never the id itself, which is
 * client free-text and can carry anything.
 */
export function unstableExternalIdShape(
  body: unknown,
): UnstableExternalIdShape | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = (body as { externalId?: unknown }).externalId;
  if (typeof raw !== "string") return null;
  return classifyExternalId(raw);
}

/**
 * Pinned wide-event meta for a refusal. Keys are fixed so dashboards stay
 * stable; the payload carries the count, the classification, and the
 * surface — never the identifier itself, which is client free-text.
 *
 * `external_id_shapes` is the sorted, de-duplicated shape set as a single
 * comma-joined string — a scalar rather than an array so it groups
 * cleanly in the event store.
 *
 * The surface rides the META rather than only the action name because a
 * wide event carries exactly one action, and most of these refusals
 * happen on a path that already names its own (`…​.validation-failed`,
 * `measurement.batch.ingest`). Overwriting that action would cost more
 * than it buys, so `external_id_rejected > 0` is the one query that finds
 * every occurrence on every surface; routes whose failure path claims no
 * action of its own additionally set `<surface>.external_id.rejected`.
 */
export function unstableExternalIdMeta(
  surface: string,
  shapes: UnstableExternalIdShape[],
): {
  external_id_rejected: number;
  external_id_shapes: string;
  external_id_surface: string;
} {
  return {
    external_id_rejected: shapes.length,
    external_id_shapes: [...new Set(shapes)].sort().join(","),
    external_id_surface: surface,
  };
}

/** Per-entry `reason` code every batch / bulk surface reports. */
export const UNSTABLE_EXTERNAL_ID_REASON = "unstable_external_id";
