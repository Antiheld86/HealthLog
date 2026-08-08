/**
 * OpenAPI route table — mood-tag taxonomy management (catalog read, custom
 * tags, custom groups, per-user layout, catalogue hide).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Request schemas come from `src/lib/mood/{custom-tags,tag-layout}.ts`
 * where they are shared with the runtime request parsing, so the wire
 * contract stays single-source. Response DTOs are declared here mirroring
 * the route handlers under `src/app/api/mood/tags/`.
 *
 * v1.13.0 shipped the custom-tag CRUD + hide surface outside the YAML;
 * v1.17.0 adds groups + layout and registers the WHOLE surface so the iOS
 * client gets a locked contract.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  createCustomTagSchema,
  updateCustomTagSchema,
  createCustomGroupSchema,
  updateCustomGroupSchema,
  hideCatalogueTagSchema,
} from "@/lib/mood/custom-tags";
import { moodTagLayoutSchema } from "@/lib/mood/tag-layout";
import { moodLevelEnum, moodSourceEnum } from "@/lib/validations/mood";
import {
  CONTACT_CIRCLE_KEYS,
  CONTACT_EXTENT_KEYS,
  CONTACT_FORM_KEYS,
  EVENT_TYPE_KEYS,
  LEISURE_CATEGORY_KEYS,
  WORK_STATUS_KEYS,
} from "@/lib/mood/context-vocabulary";
import {
  dataEnvelope,
  errorEnvelope,
  stdResponses,
  baseUpdatedAtField,
  updatedAtTokenField,
  conflictResponse409,
  invalidBaseTokenResponse,
} from "./shared";

// ── Request schemas — annotated for spec emission ────────────────────

createCustomTagSchema.meta({
  id: "CreateMoodTagRequest",
  description:
    "Create a per-user custom mood tag (BINARY only). `label` is encrypted at rest. `icon` must come from the curated allowlist (unknown name → 422). `categoryKey` picks the home group — any seeded category key or one of the caller's own `customcat:` group keys; omitted → the seeded `custom` category. Capped at 50 active custom tags per user (422).",
});

updateCustomTagSchema.meta({
  id: "UpdateMoodTagRequest",
  description:
    "Partial custom-tag edit; at least one field required. `isActive:false` archives (history intact), `isActive:true` restores. `categoryKey` moves the tag to another group (a real categoryId move).",
});

createCustomGroupSchema.meta({
  id: "CreateMoodTagGroupRequest",
  description:
    "Create a per-user custom mood-tag group. `label` is encrypted at rest; `icon` must come from the curated allowlist. Capped at 12 active custom groups per user (422).",
});

updateCustomGroupSchema.meta({
  id: "UpdateMoodTagGroupRequest",
  description:
    "Partial custom-group edit; at least one field required. `isActive:false` retires the group without touching its tags.",
});

hideCatalogueTagSchema.meta({
  id: "HideMoodTagRequest",
  description:
    "Hide / show a CATALOGUE tag for the calling user. Custom tags are hidden via their own `isActive` flag on the custom PATCH instead (this route 400s a `custom:` key).",
});

moodTagLayoutSchema.meta({
  id: "MoodTagLayout",
  description:
    "Per-user mood-tag presentation blob. `groupOrder`: category keys in display order (unknown dropped, missing appended in seeded order). `placements`: categoryKey → ordered tag keys; a placed tag renders in that group at that index, un-placed tags follow in their home category. Display-only — placements referencing hidden/archived/unknown keys are silently dropped at read time. Both fields optional: PUT merges preserve-when-absent.",
});

// ── Response DTOs ─────────────────────────────────────────────────────

const moodTagDto = z
  .object({
    key: z.string(),
    labelKey: z.string().nullable(),
    label: z.string().nullable(),
    icon: z.string().nullable(),
    kind: z.enum(["BINARY", "RATED"]),
    scaleMin: z.number().int(),
    scaleMax: z.number().int(),
    inverse: z.boolean(),
    custom: z.boolean(),
    hidden: z
      .boolean()
      .optional()
      .describe(
        "Catalogue tags only, present when `include` contains `hidden`.",
      ),
    archived: z
      .boolean()
      .optional()
      .describe(
        "Custom tags only, present when `include` contains `archived`.",
      ),
    usageCount: z
      .number()
      .int()
      .optional()
      .describe(
        "Live-entry link count for this user, present when `include` contains `usage`.",
      ),
  })
  .meta({
    id: "MoodTagDTO",
    description:
      "One effective mood tag. Render `label` when `custom`, else resolve `labelKey` against the locale.",
  });

const moodTagCategoryDto = z
  .object({
    key: z.string(),
    labelKey: z.string().nullable(),
    label: z.string().nullable(),
    icon: z.string().nullable(),
    custom: z.boolean(),
    tags: z.array(moodTagDto),
  })
  .meta({
    id: "MoodTagCategoryDTO",
    description:
      "One group of the effective tree, already per-user ordered (layout applied server-side). `custom: true` = the caller's own group (render `label`); seeded groups resolve `labelKey`.",
  });

const moodTagTreeResponse = z.object({
  categories: z.array(moodTagCategoryDto),
});

const moodCustomTagResponse = z.object({
  key: z.string(),
  labelKey: z.null(),
  label: z.string().nullable(),
  icon: z.string().nullable(),
  kind: z.enum(["BINARY", "RATED"]),
  scaleMin: z.number().int(),
  scaleMax: z.number().int(),
  inverse: z.boolean(),
  custom: z.literal(true),
});

const moodCustomTagPatchResponse = moodCustomTagResponse.extend({
  isActive: z.boolean(),
});

const moodTagGroupResponse = z.object({
  key: z.string(),
  labelKey: z.null(),
  label: z.string().nullable(),
  icon: z.string().nullable(),
  custom: z.literal(true),
});

const moodTagGroupPatchResponse = moodTagGroupResponse.extend({
  isActive: z.boolean(),
});

const moodTagLayoutResolved = z
  .object({
    groupOrder: z.array(z.string()),
    placements: z.record(z.string(), z.array(z.string())),
    // v1.32.22 (M2) — optimistic-concurrency token echoed on GET / PUT.
    updatedAt: updatedAtTokenField,
  })
  .meta({
    id: "MoodTagLayoutResolved",
    description:
      "The stored layout merged over defaults: `groupOrder` fully resolved against the user's effective category set, `placements` as stored. `updatedAt` is the optimistic-concurrency token — echo it as `baseUpdatedAt` on the next PUT.",
  });

// v1.32.22 (M2) — the PUT request extends the layout schema with the base
// token (stripped pre-Zod at runtime).
const moodTagLayoutPutRequest = moodTagLayoutSchema
  .extend({ baseUpdatedAt: baseUpdatedAtField })
  .meta({
    id: "MoodTagLayoutPutRequest",
    description:
      "Mood-tag layout to merge (preserve-when-absent), plus the optional optimistic-concurrency `baseUpdatedAt` token. The two manage cards write different fields of the same blob; echo the token to have a stale write refused with 409 instead of resurrecting the other card's overwritten field. Omit it for the legacy unconditional write.",
  });

const notFoundResponse = {
  "404": {
    description: "Not found / not owned by the caller.",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

/**
 * v1.38 — the day's context on a mood entry, in the one shape both the write
 * path and the sync feed use.
 *
 * Every field optional and nullable. The two multi-selects are closed key
 * lists; a value outside them is refused rather than stored, which is what
 * keeps the analytics and the six locale label sets from drifting apart from
 * the data.
 *
 * Exported so `./sync.ts` publishes the same object rather than declaring a
 * second one — two definitions of one payload is how a client ends up decoding
 * a field the server stopped sending.
 */
export const moodContextWire = z
  .object({
    workStatus: z
      .enum(WORK_STATUS_KEYS)
      .nullish()
      .describe("Shape of the working day."),
    workMinutes: z.number().int().min(0).max(1440).nullish(),
    overtimeMinutes: z.number().int().min(0).max(1440).nullish(),
    workLoad: z
      .number()
      .int()
      .min(0)
      .max(10)
      .nullish()
      .describe(
        "0-10, INVERSE-oriented: a higher value is a heavier day, not a better one.",
      ),
    workSatisfaction: z.number().int().min(0).max(10).nullish(),
    contactCircles: z
      .array(z.enum(CONTACT_CIRCLE_KEYS))
      .nullish()
      .describe(
        "Who the day's contact was with. Multi-select. Never scored: the count of people is not a good or a bad number.",
      ),
    contactForm: z.enum(CONTACT_FORM_KEYS).nullish(),
    contactExtent: z.enum(CONTACT_EXTENT_KEYS).nullish(),
    contactQuality: z.number().int().min(0).max(10).nullish(),
    contactSupport: z.number().int().min(0).max(10).nullish(),
    leisureCategories: z.array(z.enum(LEISURE_CATEGORY_KEYS)).nullish(),
    leisureMinutes: z.number().int().min(0).max(1440).nullish(),
    leisureJoy: z.number().int().min(0).max(10).nullish(),
    leisureRecovery: z.number().int().min(0).max(10).nullish(),
    eventType: z
      .enum(EVENT_TYPE_KEYS)
      .nullish()
      .describe("One notable event. One per entry, not a list."),
    eventValence: z
      .number()
      .int()
      .min(-5)
      .max(5)
      .nullish()
      .describe("-5 (clearly bad) to +5 (clearly good)."),
    eventAt: z.iso.datetime({ offset: true }).nullish(),
    note: z
      .string()
      .max(500)
      .nullish()
      .describe(
        "One free-text note for the whole context. AES-256-GCM at rest; the ciphertext never rides the wire.",
      ),
  })
  .meta({
    id: "MoodContext",
    description:
      "The day around a mood entry: work, contacts, leisure and one notable event. Every field optional. Sleep, activity, vitals and body symptoms are deliberately ABSENT — they are owned by their own modules and are read from there, never captured a second time here.",
  });

// ── Bulk mood backfill (iOS SyncMode) — mirrors the route's
// `bulkPayloadSchema` / `bulkEntrySchema` and the batch-envelope response.
const bulkMoodEntry = z
  .object({
    mood: moodLevelEnum,
    tags: z.array(z.string().max(50)).max(20).optional(),
    tagKeys: z
      .array(z.string().max(60))
      .max(30)
      .optional()
      .describe("Structured-tag keys from the catalog; unknown keys dropped."),
    ratedFactors: z
      .array(
        z.object({
          key: z.string().max(60),
          rating: z.number().int().min(1).max(5),
        }),
      )
      .max(30)
      .optional()
      .describe(
        "Rated mood factors; an out-of-scale rating marks THIS entry skipped, never the batch.",
      ),
    note: z.string().max(500).optional(),
    a1: z
      .number()
      .int()
      .min(0)
      .max(10)
      .nullish()
      .describe(
        "Pleasantness, 0-10. Optional: the server DERIVES it from `mood` when the entry does not carry one, so an older build that sends only the five-point label still writes a complete row. A value sent here wins over the derivation.",
      ),
    a2: z
      .number()
      .int()
      .min(0)
      .max(10)
      .nullish()
      .describe(
        'Stress, 0-10, INVERSE-oriented: a higher value is more stress. Stored exactly as set; a client that wants "up is better" flips the sign itself.',
      ),
    a3: z.number().int().min(0).max(10).nullish().describe("Energy, 0-10."),
    a4: z
      .number()
      .int()
      .min(0)
      .max(10)
      .nullish()
      .describe("Connectedness, 0-10."),
    a5: z.number().int().min(0).max(10).nullish().describe("Stability, 0-10."),
    context: moodContextWire
      .nullish()
      .describe(
        "The day's context. Absent leaves a stored context untouched on a re-post; an empty one removes it.",
      ),
    moodLoggedAt: z.iso
      .datetime({ offset: true })
      .describe("ISO instant the entry was logged."),
    source: moodSourceEnum.optional().describe("Defaults to MANUAL."),
    externalId: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "iOS-side source-stable id for idempotent dedup on the `(userId, source, externalId)` key. Must be stable across app restarts — an object description or memory address (`<Class: 0x…>`, `0x12ab34cd`) is a new value on every launch; such an entry is `skipped` with reason `unstable_external_id` while the rest of the batch still lands.",
      ),
  })
  .meta({
    id: "BulkMoodEntry",
    description: "One bulk mood entry (UPSERT keyed by `externalId`).",
  });

const bulkMoodPayload = z
  .object({
    entries: z.array(bulkMoodEntry).min(1).max(500),
  })
  .meta({
    id: "BulkMoodRequest",
    description:
      "iOS SyncMode bulk mood backfill. 1–500 entries per call; per-entry UPSERT keyed by `externalId` so re-runs are idempotent.",
  });

const bulkMoodEntryResult = z
  .object({
    index: z.number().int().nonnegative(),
    status: z
      .enum(["inserted", "duplicate", "skipped"])
      .describe(
        "`inserted`/`duplicate` — the row landed (advance the cursor). `skipped` — see `reason`.",
      ),
    reason: z.string().optional(),
    id: z
      .string()
      .optional()
      .describe("The upserted row id (absent on skips)."),
    externalId: z
      .string()
      .optional()
      .describe("Echoed back when the entry carried one, for client mapping."),
  })
  .meta({ id: "BulkMoodEntryResult" });

const bulkMoodResponse = z
  .object({
    processed: z.number().int().nonnegative(),
    inserted: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    skipped: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    ),
    entries: z.array(bulkMoodEntryResult),
  })
  .meta({ id: "BulkMoodResponse" });

// ── The day's two readings ───────────────────────────────────────────
//
// Published as the RESOLVED value. The server computes the expected value, the
// band, the count, the deviation and the age; the client renders them. Nothing
// here is a hint the client is meant to re-derive — two clients deriving the
// same figure is how they start disagreeing about it, and this figure is about
// somebody's health record.

const moodPrognosisContribution = z
  .object({
    feature: z
      .string()
      .describe(
        "Stable feature identifier: `dimension:a2`, `context:workLoad`, `context:workStatus=off` or `linked:steps`. A client that does not recognise one skips it — an older row can name a feature a later model dropped.",
      ),
    contribution: z
      .number()
      .describe(
        "Signed: how far this feature moved the expected value away from the account's own average day. Ordered by absolute size, largest first.",
      ),
  })
  .meta({ id: "MoodPrognosisContribution" });

const moodPrognosisPresent = z.object({
  present: z.literal(true),
  date: z.string().describe("The local day this is about, `YYYY-MM-DD`."),
  predicted: z
    .number()
    .describe(
      "The expected pleasantness (A1) for that day, 0-10, on the account's own past pattern. A counterfactual, never a measurement — and never to be displayed without `n` and the band.",
    ),
  ciLow: z.number().nullable(),
  ciHigh: z
    .number()
    .nullable()
    .describe(
      "The band, from the validation residuals. It widens when the model fits badly, so a wide band is the signal to present the value cautiously.",
    ),
  n: z
    .number()
    .int()
    .describe(
      "Complete days the fit used. Display it WHEREVER `predicted` is displayed: a value built from 30 days and one built from 300 look identical otherwise.",
    ),
  modelVersion: z.string(),
  computedAt: z.iso.datetime({ offset: true }),
  ageDays: z
    .number()
    .int()
    .nullable()
    .describe("Whole days between that day and the reader's today."),
  current: z
    .boolean()
    .describe(
      "Whether it is fresh enough to back a present-tense sentence. False means the copy must name the day it is about.",
    ),
  provisional: z
    .boolean()
    .describe("True below 60 days of history: label it as provisional."),
  stage: z.enum(["provisional", "regular", "seasonal"]),
  entries: z.number().int().describe("Days of history behind the ladder."),
  seasonalUnlocked: z.boolean(),
  selfAssessment: z
    .number()
    .int()
    .nullable()
    .describe(
      "The person's own rating for that day, stored exactly as they gave it. It LEADS: it is the primary value on any surface that shows both, and it is never merged with `predicted`.",
    ),
  deviation: z
    .enum(["within", "above", "below"])
    .nullable()
    .describe(
      "Where the self-assessment sat against the BAND, not against `predicted`. `within` means the day went as the account's own past days suggest.",
    ),
  deviationAmount: z
    .number()
    .nullable()
    .describe("How far outside the band, in scale points. `0` when inside."),
  contributions: z.array(moodPrognosisContribution),
});

const moodPrognosisAbsent = z.object({
  present: z.literal(false),
  reason: z
    .enum(["no-output-yet", "learning-phase", "no-pattern"])
    .describe(
      "`no-output-yet`: too few days for anything. `learning-phase`: enough to describe, not to compare. `no-pattern`: enough days, nothing steady enough in them. None of the three is an error and none is a zero.",
    ),
  entries: z.number().int(),
  nextThreshold: z
    .number()
    .int()
    .nullable()
    .describe("Days at which the next step unlocks, when a count is missing."),
});

const moodPrognosisResponse = z
  .union([moodPrognosisPresent, moodPrognosisAbsent])
  .meta({
    id: "MoodPrognosis",
    description:
      "Two separate readings of one day: what the person recorded, and what a comparison with their own past days would have expected. They are never merged — the distance between them is the finding, and a single blended figure destroys it. The comparison is a regularised regression over the account's own history: observational only, never causal. Any copy built on it must state the value as a counterfactual (a value around X would have been expected), must carry `n`, and must not say that anything caused anything.",
  });

export const moodPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/mood/prognosis": {
    get: {
      tags: ["Mood"],
      summary: "The day's own rating and what the account's days imply (v1.38)",
      description:
        "The newest stored comparison for the account, with the person's own rating for that day beside it. Written nightly by a job and never by a request: the value cannot be overwritten, which is what keeps the two readings separate. Absence is explicit (`present: false` with a reason and a count) and is a normal answer, not an error — the comparison refuses when the history does not support one. Whole-record read: the fit takes the day's context AND the sleep, activity and recovery figures the owning modules hold, and it names them, so a section-scoped grant is refused rather than served a filtered list. Gated: `module.disabled` 403 when the mood module is off.",
      responses: {
        "200": {
          description: "The day's two readings, or an explained absence.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodPrognosisResponse,
                "MoodPrognosisEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/mood-entries/bulk": {
    post: {
      tags: ["Mood"],
      summary: "Bulk mood backfill (iOS SyncMode)",
      description:
        "Drains the iOS local mood log in one shot: up to 500 entries per call with per-entry UPSERT semantics keyed by `externalId`, so an adopt-on-pair backfill or a retried batch is idempotent. Idempotent via the `Idempotency-Key` header too. Per-entry status (`inserted` / `duplicate` / `skipped`) advances the client cursor. Rate-limited 60/min/user. An over-size batch 422s (`meta.errorCode = mood.bulk.too_large`); a malformed body 422s (`mood.bulk.invalid`).",
      requestBody: {
        required: true,
        content: { "application/json": { schema: bulkMoodPayload } },
      },
      responses: {
        "200": {
          description: "Batch processed (always 200 on a well-formed body).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                bulkMoodResponse,
                "BulkMoodResponseEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/mood/tags": {
    get: {
      tags: ["Mood"],
      summary: "Effective per-user mood-tag tree (v1.8.5 / v1.13.0 / v1.17.0)",
      description:
        "The fully-resolved, ordered Category → Tag tree: seeded catalogue + the caller's custom tags and groups, per-user layout (group order + placements) applied server-side, hidden catalogue tags omitted. `include` is a comma list: `hidden` (hidden catalogue tags, `hidden:true`), `archived` (own inactive custom tags, `archived:true`), `usage` (per-tag `usageCount`). With any flag set, the caller's own empty groups are kept; the plain read drops empty categories.",
      requestParams: {
        query: z.object({
          include: z
            .string()
            .optional()
            .describe("Comma list of `hidden`, `archived`, `usage`."),
        }),
      },
      responses: {
        "200": {
          description: "The effective tag tree.",
          content: {
            "application/json": {
              schema: dataEnvelope(moodTagTreeResponse, "MoodTagTreeEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/mood/tags/custom": {
    post: {
      tags: ["Mood"],
      summary: "Create a custom mood tag (v1.13.0 / v1.17.0)",
      description:
        "Mints a `custom:<uuid>` key, encrypts the label at rest, stores a BINARY tag owned by the caller under the chosen group (default: the seeded `custom` category). 422 over the 50-tag cap or on an unknown / foreign `categoryKey`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createCustomTagSchema } },
      },
      responses: {
        "201": {
          description: "Custom tag created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodCustomTagResponse,
                "MoodCustomTagCreatedEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/mood/tags/custom/{key}": {
    patch: {
      tags: ["Mood"],
      summary: "Update a custom mood tag (v1.13.0 / v1.17.0)",
      description:
        "Owner-scoped: another user's key or a catalogue key 404s. Rename (re-encrypts), re-icon, archive/restore via `isActive`, or move groups via `categoryKey`.",
      requestParams: { path: z.object({ key: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateCustomTagSchema } },
      },
      responses: {
        "200": {
          description: "Custom tag updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodCustomTagPatchResponse,
                "MoodCustomTagPatchEnvelope",
              ),
            },
          },
        },
        ...notFoundResponse,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Mood"],
      summary: "Archive or purge a custom mood tag (v1.13.0)",
      description:
        "Default: soft-deactivates (`isActive:false`) — history intact, restorable via PATCH. `?purge=true`: hard-deletes the row; the FK cascade removes its entry links. Owner-scoped 404.",
      requestParams: {
        path: z.object({ key: z.string() }),
        query: z.object({ purge: z.enum(["true", "false"]).optional() }),
      },
      responses: {
        "200": {
          description: "Archived (or purged).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ key: z.string(), purged: z.boolean() }),
                "MoodCustomTagDeleteEnvelope",
              ),
            },
          },
        },
        ...notFoundResponse,
        ...stdResponses,
      },
    },
  },
  "/api/mood/tags/{key}/hidden": {
    put: {
      tags: ["Mood"],
      summary: "Hide / show a catalogue mood tag (v1.13.0)",
      description:
        "Per-user hide of a CATALOGUE tag (upserts / removes a `mood_tag_hidden` row). 400 on a `custom:` key — custom tags archive via their own `isActive`.",
      requestParams: { path: z.object({ key: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: hideCatalogueTagSchema } },
      },
      responses: {
        "200": {
          description: "Visibility updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ key: z.string(), hidden: z.boolean() }),
                "MoodTagHiddenEnvelope",
              ),
            },
          },
        },
        "400": {
          description: "Custom-tag key — use the custom PATCH instead.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...notFoundResponse,
        ...stdResponses,
      },
    },
  },
  "/api/mood/tags/groups": {
    post: {
      tags: ["Mood"],
      summary: "Create a custom mood-tag group (v1.17.0)",
      description:
        "Mints a `customcat:<uuid>` key, encrypts the label at rest, stores a group owned by the caller. 422 over the 12-group cap.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createCustomGroupSchema } },
      },
      responses: {
        "201": {
          description: "Custom group created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodTagGroupResponse,
                "MoodTagGroupCreatedEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/mood/tags/groups/{key}": {
    patch: {
      tags: ["Mood"],
      summary: "Update a custom mood-tag group (v1.17.0)",
      description:
        "Owner-scoped: another user's key or a seeded category key 404s. Rename (re-encrypts), re-icon, retire/restore via `isActive`.",
      requestParams: { path: z.object({ key: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateCustomGroupSchema } },
      },
      responses: {
        "200": {
          description: "Custom group updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodTagGroupPatchResponse,
                "MoodTagGroupPatchEnvelope",
              ),
            },
          },
        },
        ...notFoundResponse,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Mood"],
      summary: "Delete a custom mood-tag group (v1.17.0)",
      description:
        "Non-destructive: the group's custom tags re-home to the seeded `custom` category, catalogue-tag placements evaporate back to their seeded category, the layout drops the group, then the row soft-deactivates (default) or hard-deletes (`?purge=true`). No tag and no entry link is deleted.",
      requestParams: {
        path: z.object({ key: z.string() }),
        query: z.object({ purge: z.enum(["true", "false"]).optional() }),
      },
      responses: {
        "200": {
          description: "Group deleted; `rehomedCount` custom tags moved.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  key: z.string(),
                  purged: z.boolean(),
                  rehomedCount: z.number().int(),
                }),
                "MoodTagGroupDeleteEnvelope",
              ),
            },
          },
        },
        ...notFoundResponse,
        ...stdResponses,
      },
    },
  },
  "/api/mood/tags/layout": {
    get: {
      tags: ["Mood"],
      summary: "Read the per-user mood-tag layout (v1.17.0)",
      description:
        "Returns the stored blob merged over defaults: `groupOrder` resolved against the caller's effective category set (seeded + own groups), `placements` as stored.",
      responses: {
        "200": {
          description: "Resolved layout.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodTagLayoutResolved,
                "MoodTagLayoutGetEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Mood"],
      summary: "Update the per-user mood-tag layout (v1.17.0)",
      description:
        "Preserve-when-absent merge: a `groupOrder`-only PUT keeps the stored `placements` and vice versa. Bounded: ≤ 50 groups, ≤ 400 placement entries, keys ≤ 80 chars. Returns the resolved layout.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: moodTagLayoutPutRequest } },
      },
      responses: {
        "200": {
          description: "Merged + resolved layout with the fresh token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                moodTagLayoutResolved,
                "MoodTagLayoutPutEnvelope",
              ),
            },
          },
        },
        ...conflictResponse409("Mood-tag layout", "mood_tag_layout_conflict"),
        ...stdResponses,
        ...invalidBaseTokenResponse,
      },
    },
  },
};
