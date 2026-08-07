/**
 * Mood-entry validation schemas.
 *
 * v1.32.33 — the file previously also carried the credential, webhook and
 * pull-response schemas of the retired moodLog bridge. Mood is tracked
 * natively, so only the entry schemas remain and the module is named for
 * what it validates.
 */
import { z } from "zod/v4";
import { validateEntryInstant } from "@/lib/validations/entry-instant";
import { assertStableExternalId } from "@/lib/validations/external-id";

// --- CRUD schemas for mood entries ---

export const moodLevelEnum = z.enum([
  "SUPER_GUT",
  "GUT",
  "OKAY",
  "SCHLECHT",
  "LAUSIG",
]);

/**
 * Provenance of a stored mood entry. `MOODLOG` is a legacy value: the bridge
 * that wrote it was removed in v1.32.33, but rows it created are the user's
 * own history and keep their label, so the list filter and the source badge
 * must keep resolving it. Nothing mints new `MOODLOG` rows.
 */
export const moodSourceEnum = z.enum([
  "MANUAL",
  "MOODLOG",
  "WEB",
  "TELEGRAM",
  "DAYLIO",
]);

const MOOD_SCORE_MAP: Record<string, number> = {
  SUPER_GUT: 5,
  GUT: 4,
  OKAY: 3,
  SCHLECHT: 2,
  LAUSIG: 1,
};

export function getScoreForMood(mood: string): number {
  return MOOD_SCORE_MAP[mood] ?? 3;
}

/**
 * The five-point mood label mapped onto the level-A pleasantness scale (A1).
 *
 * The quick check-in asks one question and offers five faces, and it stays a
 * full-value capture path: its answer produces a real A1 rather than a
 * degraded one. This is the single place those five numbers exist. A second
 * copy anywhere in the tree — including inside a migration — is a drift
 * waiting to happen, which is why the backfill's SQL is read back and compared
 * against this map by a test rather than trusted to stay in step.
 *
 * The endpoints are 1 and 9, not 0 and 10. "LAUSIG" means as bad as this
 * instrument can express, not as bad as a person can feel; pinning it to 0
 * would make every mapped historical entry look more extreme than every future
 * hand-set one and would leave the true extremes unreachable. 5 is the
 * concept's neutral midpoint and is where "OKAY" belongs.
 */
const MOOD_A1_MAP: Record<string, number> = {
  SUPER_GUT: 9,
  GUT: 7,
  OKAY: 5,
  SCHLECHT: 3,
  LAUSIG: 1,
};

/**
 * A1 for a five-point mood label. An unrecognised label answers the neutral
 * midpoint, matching what `getScoreForMood` answers for the same input.
 */
export function getA1ForMood(mood: string): number {
  return MOOD_A1_MAP[mood] ?? 5;
}

/** Read-only view of the A1 map, for the guards that pin the backfill to it. */
export function moodA1Map(): Readonly<Record<string, number>> {
  return MOOD_A1_MAP;
}

// v1.8.5 — structured-tag keys picked from the catalog (`mood_tags.key`).
// Additive alongside the flat free-text `tags`: an entry can carry both.
// Bounded so a single create can't fan out an unbounded link set.
const structuredTagKeys = z.array(z.string().max(60)).max(30);

// v1.12.0 — rated mood factors. A factor is a catalog `MoodTag` of
// `kind = 'RATED'`; the user scores it per entry, and the score persists
// on `MoodEntryTagLink.rating`. The wire shape is a parallel array to
// `tagKeys` (binary), keeping the binary contract byte-identical and the
// iOS Codable model simple (`[{ key, rating }]`).
//
// The Zod `rating` bound here is the OUTER envelope (1..5 covers every
// seeded factor's scale). The REAL gate is per-tag: after resolving each
// key to its `MoodTag`, the server rejects a rating outside the tag's own
// `scaleMin..scaleMax` (every seeded factor is 1..5 today, but a factor
// with a tighter scale is rejected here too). See `resolveRatedFactors`
// in `src/lib/mood/tag-links.ts`.
const ratedFactor = z.object({
  key: z.string().max(60),
  rating: z.number().int().min(1).max(5),
});
const ratedFactors = z.array(ratedFactor).max(30);

// v1.37 — the five level-A self-state values, each 0-10. Optional on every
// path: a client that sends only a five-point label still writes a complete
// entry, because the server derives A1 from the label. A2 to A5 are only ever
// what the user set, so an omitted one stays absent rather than defaulting to
// the middle of the scale. The bound is the scale itself; `MOOD_DIMENSIONS`
// (`src/lib/mood/dimensions.ts`) carries the anchors the numbers mean.
const levelADimension = z.number().int().min(0).max(10);

export const createMoodEntrySchema = z
  .object({
    mood: moodLevelEnum,
    tags: z.array(z.string().max(50)).max(20).optional(),
    // v1.8.5 — structured-tag keys from the taxonomy. Server resolves each
    // key to a `MoodTag` row and writes the `MoodEntryTagLink` join;
    // unknown keys are dropped silently (the catalog is the source of
    // truth, a stale client can't mint a tag).
    tagKeys: structuredTagKeys.optional(),
    // v1.12.0 — rated factors scored 1..5 (or the factor's own scale).
    // Parallel to the binary `tagKeys`; persisted on
    // `MoodEntryTagLink.rating`. Out-of-scale or non-RATED keys are
    // rejected (422) / dropped server-side per the catalog.
    ratedFactors: ratedFactors.optional(),
    // v1.37 — the five level-A values the detail sliders capture. Absent
    // means the user did not answer; `a1` absent means the server derives it
    // from `mood`, which keeps the one-tap check-in a full entry.
    a1: levelADimension.optional(),
    a2: levelADimension.optional(),
    a3: levelADimension.optional(),
    a4: levelADimension.optional(),
    a5: levelADimension.optional(),
    // v1.4.30 H-5 — first-class free-text note. Replaces the
    // `tags: ["note:<text>"]` workaround. Capped at 500 chars so the
    // Coach evidence shelf renders cleanly without truncating chips.
    note: z.string().max(500).optional(),
    // v1.17 W1b — plausibility bound (shared `validateEntryInstant`): no
    // future instants beyond a 5-min clock-skew tolerance, no instant before
    // 1900. Mirrors the measurement + medication-intake bound.
    moodLoggedAt: validateEntryInstant(
      z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
    ),
    source: moodSourceEnum.optional().default("MANUAL"),
    // v1.12.1 — optional source-stable id (e.g. an iOS SwiftData row UUID).
    // When present, the create upserts on `(userId, source, externalId)`
    // so a re-post with the same id updates the existing row in place
    // instead of either 409-ing or minting a duplicate — the idempotent
    // re-import iOS drives over Bearer. NULL keeps the legacy
    // `(userId, date, moodLoggedAt)` behaviour. Bound matches the bulk
    // `externalId` so one path can't accept an id the other rejects.
    externalId: z.string().min(1).max(120).optional(),
  })
  // The upsert key is only idempotent while the id is stable; an id that
  // rotates per client launch mints a fresh entry on every re-post. The
  // bulk twin carries the same rule per entry (it cannot fail the whole
  // batch on one bad row).
  .superRefine(assertStableExternalId);

export const updateMoodEntrySchema = z.object({
  mood: moodLevelEnum.optional(),
  tags: z.array(z.string().max(50)).max(20).nullable().optional(),
  // v1.8.5 — full replacement of the structured-tag set when present.
  // `null` clears every link; omit to leave links untouched.
  tagKeys: structuredTagKeys.nullable().optional(),
  // v1.12.0 — full replacement of the rated-factor set when present.
  // `null` clears every rated link; omit to leave them untouched.
  ratedFactors: ratedFactors.nullable().optional(),
  // v1.37 — level-A values on the edit path. Omitted leaves the stored value
  // alone; an explicit `null` clears it, which is how a user takes back an
  // answer they did not mean to give. Editing the five-point label without
  // sending `a1` re-derives A1, the same way it re-derives `score`.
  a1: levelADimension.nullable().optional(),
  a2: levelADimension.nullable().optional(),
  a3: levelADimension.nullable().optional(),
  a4: levelADimension.nullable().optional(),
  a5: levelADimension.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  // v1.17 W1b — same plausibility bound on the edit path.
  moodLoggedAt: validateEntryInstant(
    z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  ).optional(),
});

export const listMoodEntriesSchema = z.object({
  mood: moodLevelEnum.optional(),
  // v1.15.13 — source filter for the management list. Validated against
  // the mood source set; threaded into the list `where` (the `userId` +
  // `deletedAt: null` pins stay). Backed by the `(userId, source,
  // moodLoggedAt)` index (migration 0136).
  source: moodSourceEnum.optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  sortBy: z
    .enum(["date", "mood", "score", "moodLoggedAt", "source"])
    .optional()
    .default("moodLoggedAt"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type CreateMoodEntryInput = z.infer<typeof createMoodEntrySchema>;
export type UpdateMoodEntryInput = z.infer<typeof updateMoodEntrySchema>;
export type ListMoodEntriesInput = z.infer<typeof listMoodEntriesSchema>;
