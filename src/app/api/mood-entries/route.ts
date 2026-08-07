import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import {
  createMoodEntrySchema,
  listMoodEntriesSchema,
  getScoreForMood,
} from "@/lib/validations/mood";
import {
  unstableExternalIdMeta,
  unstableExternalIdShape,
} from "@/lib/validations/external-id";
import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { withIdempotency } from "@/lib/idempotency";
import { encryptNote, shapeMoodNote } from "@/lib/crypto/note-cipher";
import { moodDateKey, DEFAULT_TIMEZONE } from "@/lib/mood/date-key";
import { levelAForWire, levelAForWrite } from "@/lib/mood/level-a";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";
import {
  createTagLinks,
  RatedFactorOutOfRangeError,
} from "@/lib/mood/tag-links";

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    return JSON.parse(tags) as string[];
  } catch {
    return [];
  }
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "mind");

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = listMoodEntriesSchema.safeParse(params);
  if (!parsed.success) {
    // v1.4.43 W6 — surface every Zod issue + audit breadcrumb keyed
    // `mood-entries.list.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "mood-entries.list.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row so Zod
    // codes that embed the offending value (`invalid_enum_value` etc.)
    // cannot leak user-typed content. Mood-entries carry free-text
    // `note` + `tags`; defensive strip everywhere mood content can
    // reach a Zod issue.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // v1.36.0 — through `auditLog()` rather than a bare `prisma.auditLog
    // .create`, because that helper is the only thing that stamps
    // `actorUserId`. Filed under the resolved record either way; without the
    // stamp a delegate's malformed query would read as the owner's own.
    void auditLog("mood-entries.list.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "mood.list.invalid",
    });
  }

  const { mood, source, from, to, limit, offset, sortBy, sortDir } =
    parsed.data;

  const where = {
    userId: user.id,
    // v1.7.0 sync — hide soft-deleted (tombstoned) rows from the list.
    deletedAt: null,
    ...(mood && { mood }),
    // v1.15.13 — management-list source filter.
    ...(source && { source }),
    ...(from || to
      ? {
          date: {
            ...(from && { gte: from }),
            ...(to && { lte: to }),
          },
        }
      : {}),
  };

  const [entries, total] = await Promise.all([
    prisma.moodEntry.findMany({
      where,
      orderBy: { [sortBy]: sortDir },
      take: limit,
      skip: offset,
      // v1.8.5 — include the structured-tag link keys so the edit form
      // can pre-populate the taxonomy picker.
      // v1.12.0 — also carry the per-link `rating` + the tag `kind` so
      // the client can split binary tags from rated factors on hydrate.
      include: {
        tagLinks: {
          select: {
            rating: true,
            moodTag: { select: { key: true, kind: true } },
          },
        },
      },
    }),
    prisma.moodEntry.count({ where }),
  ]);

  annotate({
    action: { name: "mood-entries.list" },
    meta: { total, limit, offset },
  });

  const entriesWithParsedTags = entries.map(({ tagLinks, ...e }) => ({
    // v1.23 — decrypt `noteEncrypted` onto `note`, strip the ciphertext.
    ...shapeMoodNote(e),
    // v1.37 — the five level-A values under the keys the create path takes,
    // so the edit form reads back what it wrote instead of mapping column
    // names to wire names by hand.
    ...levelAForWire(e),
    tags: parseTags(e.tags),
    // v1.8.5 — flat list of binary structured-tag keys attached to the
    // entry (rated factors are surfaced separately below).
    tagKeys: tagLinks
      .filter((link) => link.moodTag.kind !== "RATED")
      .map((link) => link.moodTag.key),
    // v1.12.0 — rated factors with their per-entry score, so the edit
    // form re-renders the sliders without a refetch.
    ratedFactors: tagLinks
      .filter((link) => link.moodTag.kind === "RATED" && link.rating !== null)
      .map((link) => ({
        key: link.moodTag.key,
        rating: link.rating as number,
      })),
  }));

  return apiSuccess({
    entries: entriesWithParsedTags,
    meta: { total, limit, offset },
  });
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postMoodEntry));

async function postMoodEntry(request: NextRequest) {
  // v1.37.0 — MANAGE. A mood row entered by a manager is an observation
  // transcribed, and the audit trail says so for the retention window. What
  // the delegated arm does not get is the sync client's upsert handle; see
  // the `externalId` refusal below.
  const { user, actor } = await requireRecordAuth("manage", "mind");

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const parsed = createMoodEntrySchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — iOS mood log hot path; multi-issue 422 + audit
    // breadcrumb keyed `mood-entries.create.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    const shape = unstableExternalIdShape(body);
    annotate({
      action: { name: "mood-entries.create.validation-failed" },
      meta: {
        issue_count: issues.length,
        ...(shape ? unstableExternalIdMeta("mood.create", [shape]) : {}),
      },
    });
    // v1.4.49 — strip `message` from the audit-ledger row; the
    // mood-create schema's free-text `note` + `tags` could land in a
    // Zod issue message verbatim.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // v1.37.0 — through `auditLog()` rather than a bare `prisma.auditLog
    // .create`, because that helper is the only writer that stamps
    // `actorUserId`. Filed under the resolved record either way; without the
    // stamp a manager's malformed payload would read as the owner's own.
    void auditLog("mood-entries.create.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "mood.create.invalid",
    });
  }

  const {
    mood,
    tags,
    tagKeys,
    ratedFactors,
    note,
    moodLoggedAt,
    source,
    externalId,
  } = parsed.data;
  // v1.37 — the five level-A values, built field by field from the parsed
  // body (never spread) and resolved once for every branch below. A1 falls
  // back to the derivation from `mood`; the other four are whatever the user
  // set, or nothing.
  const levelA = levelAForWrite(mood, {
    a1: parsed.data.a1,
    a2: parsed.data.a2,
    a3: parsed.data.a3,
    a4: parsed.data.a4,
    a5: parsed.data.a5,
  });
  // v1.4.25 W7b (Decision A) — anchor the `date` string to the user's
  // current displayTimezone and store the resolved zone on the row.
  // Legacy rows with `tz IS NULL` continue to read as Europe/Berlin
  // (see `src/lib/mood/date-key.ts`).
  const tz = user.timezone ?? DEFAULT_TIMEZONE;
  const date = moodDateKey(moodLoggedAt, tz);
  const score = getScoreForMood(mood);
  // v1.12.1 — `source` carries a schema default of "MANUAL"; resolve it
  // once so the externalId upsert key (`(userId, source, externalId)`)
  // and the row write agree on the exact value.
  const resolvedSource = source ?? "MANUAL";

  // C6 — the delegated arm refuses `externalId`. It is the sync client's dedup
  // handle: supplying it turns this create into an upsert on
  // `(userId, source, externalId)`, which is a device's contract with its own
  // rows and not something a second person should be able to aim at somebody
  // else's record. A person entering a mood through the UI never sends one.
  if (actor.id !== user.id && externalId) {
    annotate({
      action: { name: "mood-entries.create.external-id-refused" },
      meta: { delegated: true },
    });
    return apiError(
      "externalId cannot be supplied on a record you manage",
      422,
      { errorCode: "mood.create.external_id_not_delegable" },
    );
  }

  try {
    // v1.8.5 — write the entry and its structured-tag links in one
    // transaction. The links are user-intended content, not a cache, so a
    // tag-link failure must roll the entry back too — otherwise a client
    // retry on the 5xx mints a duplicate entry. The tx client is threaded
    // through the helper so both writes commit (or abort) together.
    const { entry, persistedTagKeys, persistedRatedFactors } =
      await prisma.$transaction(async (tx) => {
        // v1.12.1 — when the client supplies a source-stable `externalId`,
        // upsert on the NULL-distinct `(userId, source, externalId)` key so
        // a re-post with the same id updates the existing row in place
        // (idempotent re-import) instead of minting a duplicate or 409-ing.
        // Without an `externalId`, fall back to the legacy first-write
        // `create` exactly as before — a same-tuple re-post then trips the
        // `(userId, date, moodLoggedAt)` unique and surfaces as a 409 below.
        const created = externalId
          ? await tx.moodEntry.upsert({
              where: {
                userId_source_externalId: {
                  userId: user.id,
                  source: resolvedSource,
                  externalId,
                },
              },
              create: {
                userId: user.id,
                date,
                tz,
                mood,
                score,
                moodA1: levelA.moodA1,
                stressA2: levelA.stressA2,
                energyA3: levelA.energyA3,
                connectionA4: levelA.connectionA4,
                stabilityA5: levelA.stabilityA5,
                tags: tags ? JSON.stringify(tags) : null,
                note: null,
                noteEncrypted: encryptNote(note ?? null),
                source: resolvedSource,
                externalId,
                moodLoggedAt,
              },
              // A re-post replaces the row, so the level-A values are restated
              // here too. Omitting them would leave a stress reading from an
              // earlier post sitting beside a mood the user has since changed
              // — the same staleness the `score` restatement already avoids.
              update: {
                date,
                tz,
                mood,
                score,
                moodA1: levelA.moodA1,
                stressA2: levelA.stressA2,
                energyA3: levelA.energyA3,
                connectionA4: levelA.connectionA4,
                stabilityA5: levelA.stabilityA5,
                tags: tags ? JSON.stringify(tags) : null,
                note: null,
                noteEncrypted: encryptNote(note ?? null),
                moodLoggedAt,
              },
            })
          : await tx.moodEntry.create({
              data: {
                userId: user.id,
                date,
                tz,
                mood,
                score,
                moodA1: levelA.moodA1,
                stressA2: levelA.stressA2,
                energyA3: levelA.energyA3,
                connectionA4: levelA.connectionA4,
                stabilityA5: levelA.stabilityA5,
                tags: tags ? JSON.stringify(tags) : null,
                note: null,
                noteEncrypted: encryptNote(note ?? null),
                source: resolvedSource,
                moodLoggedAt,
              },
            });

        if (
          (tagKeys && tagKeys.length > 0) ||
          (ratedFactors && ratedFactors.length > 0)
        ) {
          // Unknown / non-RATED keys are dropped inside the helper (the
          // catalog is the source of truth). An out-of-scale rating
          // throws `RatedFactorOutOfRangeError`, rolling the tx back.
          await createTagLinks(
            created.id,
            user.id,
            tagKeys ?? [],
            tx,
            ratedFactors ?? [],
          );
        }

        // v1.8.5 / v1.12.0 — read the persisted links back so the create
        // response mirrors the list GET shape exactly: binary keys and
        // rated factors split by `kind` (unknown keys already filtered).
        const links = await tx.moodEntryTagLink.findMany({
          where: { moodEntryId: created.id },
          select: {
            rating: true,
            moodTag: { select: { key: true, kind: true } },
          },
        });

        return {
          entry: created,
          persistedTagKeys: links
            .filter((link) => link.moodTag.kind !== "RATED")
            .map((link) => link.moodTag.key),
          persistedRatedFactors: links
            .filter(
              (link) => link.moodTag.kind === "RATED" && link.rating !== null,
            )
            .map((link) => ({
              key: link.moodTag.key,
              rating: link.rating as number,
            })),
        };
      });

    await auditLog("moodEntry.create", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { moodEntryId: entry.id, mood },
    });

    annotate({
      action: { name: "mood-entries.create" },
      meta: { moodEntryId: entry.id, mood },
    });

    // v1.4.34 IW-G — bust per-user mood + achievements + analytics caches.
    invalidateUserMood(user.id);

    // v1.4.39 W-MOOD — refresh the persisted DAY rollup for the
    // entry's bucket and enqueue the WEEK / MONTH / YEAR folds.
    // Best-effort: a failure here must not surface as a 5xx to the
    // user, the rollup is a cache tier, not a write-path invariant.
    try {
      await recomputeMoodBucketsForEntry(user.id, date);
    } catch (rollupErr) {
      annotate({
        meta: {
          mood_rollup_write_failed: true,
          mood_rollup_write_error:
            rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
        },
      });
    }

    return apiSuccess(
      {
        // v1.23 — decrypt `noteEncrypted` onto `note`, strip the ciphertext.
        ...shapeMoodNote(entry),
        // v1.37 — level-A values under their wire keys (see the list read).
        ...levelAForWire(entry),
        tags: parseTags(entry.tags),
        // v1.8.5 — surface the persisted structured-tag keys so a client
        // hydrating from the create response renders the tag set without a
        // refetch (shape-matches the list GET).
        tagKeys: persistedTagKeys,
        // v1.12.0 — rated factors with their per-entry score.
        ratedFactors: persistedRatedFactors,
      },
      201,
    );
  } catch (err) {
    // v1.12.0 — a factor rating outside its catalog scale is a client
    // error, not a 5xx. The Zod schema only enforces the 1..5 envelope;
    // the per-tag scale (e.g. 1..2 for conflict) is the real gate.
    if (err instanceof RatedFactorOutOfRangeError) {
      annotate({
        action: { name: "mood-entries.create.rated-factor-out-of-range" },
        meta: { scaleMin: err.scaleMin, scaleMax: err.scaleMax },
      });
      return apiError(err.message, 422, {
        errorCode: "mood.ratedFactor.out_of_range",
      });
    }
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return apiError("A mood entry with this data already exists", 409, {
        errorCode: "mood.duplicate_timestamp",
      });
    }
    throw err;
  }
}
