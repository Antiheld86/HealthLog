/**
 * OpenAPI route table — personal bests and badges.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 *
 * Two reads that belong together: `PersonalRecord` rows (the detected bests
 * per metric) and the derived achievement grid. Both are delegable — a
 * delegate reads what the RECORD earned, never a copy of their own tally
 * under the owner's name — and both are read-only in fact as well as in
 * declaration.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  MODULE_DISABLED_DESCRIPTION,
  dataEnvelope,
  errorEnvelope,
  measurementSourceEnum,
  measurementTypeEnum,
  recordRefusal,
  stdResponses,
} from "./shared";

const personalRecord = z
  .object({
    id: z.string(),
    userId: z
      .string()
      .describe(
        "The RECORD's user id — under a delegated read this is the owner, not the caller.",
      ),
    metricType: measurementTypeEnum,
    metricSlot: z
      .string()
      .nullable()
      .describe(
        'Per-sport bucket for workout-driven bests (e.g. "running_5km_time"). Null for a plain measurement-driven best, where the metric type alone is the dimension.',
      ),
    direction: z
      .enum(["MAX", "MIN"])
      .describe(
        "Which way is better. MAX for steps / VO2 max / HRV / distance; MIN for resting heart rate, body fat, audio exposure.",
      ),
    value: z.number(),
    unit: z.string(),
    achievedAt: z.iso.datetime({ offset: true }),
    sourceMeasurementId: z
      .string()
      .nullable()
      .describe(
        "The measurement that achieved the record. Nulled rather than cascaded when that measurement is later deleted, so the historical fact survives the reading behind it.",
      ),
    source: measurementSourceEnum,
    externalId: z.string().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "PersonalRecord",
    description:
      "One detected personal best. Rows are written by the detection worker, never by a client — there is no write endpoint on this resource.",
  });

const achievement = z
  .object({
    id: z.string(),
    metric: z.string().describe("The counter this badge is graded against."),
    category: z.enum([
      "medication",
      "vitals",
      "mood",
      "security",
      "engagement",
      "hidden",
    ]),
    titleKey: z
      .string()
      .describe(
        "i18n key. The default payload ships keys, not prose — the web client translates. `?format=ios` resolves them server-side instead.",
      ),
    descriptionKey: z.string(),
    icon: z.string().describe("Lucide icon name."),
    format: z.enum(["count", "days", "percent"]),
    target: z.number(),
    current: z.number(),
    points: z.number().int(),
    unlocked: z.boolean(),
    progressPercent: z.number(),
    completedAt: z.iso.datetime({ offset: true }).nullable(),
    isHidden: z
      .boolean()
      .describe(
        "An Easter-egg badge. While locked, the row is REDACTED to an opaque placeholder — the real title, description, icon and target are not on the wire until it unlocks.",
      ),
  })
  .meta({
    id: "Achievement",
    description:
      "One badge with its progress. A locked hidden badge carries placeholder copy and zeroed target/current: the spoiler shield is applied server-side, not left to the client.",
  });

const achievementsWebResponse = z
  .object({
    summary: z.object({
      unlockedCount: z.number().int(),
      totalCount: z.number().int(),
      earnedPoints: z.number().int(),
      totalPoints: z.number().int(),
      completionPercent: z
        .number()
        .int()
        .describe("100 when the visible set is empty, not 0."),
      nextAchievement: achievement
        .nullable()
        .describe("The closest badge still locked, redacted if hidden."),
    }),
    achievements: z.array(achievement),
    metrics: z
      .record(z.string(), z.unknown())
      .describe(
        "The raw counters behind the badges. Counters that ONLY back a still-locked hidden badge are dropped from this map — the same spoiler shield the badge rows get. Partial by construction, so read defensively.",
      ),
  })
  .meta({
    id: "AchievementsResponse",
    description:
      "The badge grid as the web surface consumes it: i18n keys plus the summary tally and the underlying counters. Badges whose owning module the account has turned off are not evaluated and do not appear.",
  });

const achievementIosEntry = z
  .object({
    id: z.string(),
    key: z
      .string()
      .describe("Same value as `id`; kept for the client's model."),
    title: z.string().describe("Resolved in the caller's locale."),
    description: z.string(),
    iconName: z.string(),
    unlocked: z.boolean(),
    unlockedAt: z.iso.datetime({ offset: true }).nullable(),
    progress: z.number().describe("0–1, clamped. Not the 0–100 percent."),
    category: z.string(),
    points: z.number().int(),
    target: z.number(),
    current: z.number(),
    isHidden: z.boolean(),
  })
  .meta({
    id: "AchievementIosEntry",
    description:
      "The flattened, pre-translated badge the native client renders. Note the differences from the web shape: translated strings instead of keys, `iconName` instead of `icon`, `unlockedAt` instead of `completedAt`, and `progress` as a 0–1 fraction.",
  });

export const awardsPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/personal-records": {
    get: {
      tags: ["Awards"],
      summary: "List detected personal bests",
      description:
        "The record's personal bests, newest achievement first. Read-only — rows come from the detection worker and no endpoint creates or edits one.\n\nBoth query parameters are validated and a bad value is a 422. They were forgiving until this release, and in one direction that was worse than merely quiet: dropping an unrecognised `metricType` WIDENED the read to every metric, so a typo returned more rows than the caller asked for. The `limit` ceiling refuses rather than clamps for the same reason.\n\nDelegable on a `measurements` grant.",
      parameters: [
        {
          name: "metricType",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "A `MeasurementType` to filter to. A value outside the enum is refused with 422 — it is not dropped, because dropping it would widen the read rather than narrow it.",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          description:
            "Page cap, default 100, ceiling 500. A non-integer, a zero, a negative value or anything above 500 is refused with 422 rather than corrected — serving a different number of rows than were asked for is another difference nobody is told about.",
        },
      ],
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The record's personal bests, newest first.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(personalRecord),
                "ListPersonalRecordsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        "422": {
          description:
            "`metricType` or `limit` carried an unacceptable value. `meta.errorCode` = `personal_records.invalid_query`, with the offending path under `details.issues`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/gamification/achievements": {
    get: {
      tags: ["Awards"],
      summary: "Read the badge grid",
      description:
        "Every badge with its progress, plus the summary tally. Two response shapes on one path: `?format=ios` returns a flat array of pre-translated entries, anything else returns the web object (`summary` / `achievements` / `metrics`) with i18n keys.\n\nEverything is derived from the record's own history, so a delegate sees what the owner earned. Badge categories whose owning module the account has disabled are skipped from evaluation entirely — they do not appear as locked, they do not appear at all.\n\nServed through a stale-while-revalidate cache with a 10-minute stale window, so a freshly crossed threshold can take a poll or two to surface. The cache holds the web shape; the iOS translation runs after the read, which is why switching locales does not need a separate cache entry.\n\nRead-only: since v1.35.3 the unlock rows are written by the `achievement-unlock-sweep` job rather than by this GET, and the payload is identical whether or not a row exists yet.\n\nDelegable on a whole-record grant — the grid spans every module that carries a badge category, so a per-section grant is not enough.",
      parameters: [
        {
          name: "format",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["ios"] },
          description:
            "`ios` selects the flat, pre-translated array. Any other value (or none) returns the web object.",
        },
      ],
      responses: {
        ...recordRefusal(MODULE_DISABLED_DESCRIPTION),
        "200": {
          description:
            "The badge grid. `AchievementsResponse` by default, an array of `AchievementIosEntry` under `?format=ios`.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.union([
                  achievementsWebResponse,
                  z.array(achievementIosEntry),
                ]),
                "AchievementsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
