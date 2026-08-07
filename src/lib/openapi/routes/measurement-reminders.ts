/**
 * OpenAPI route table — Vorsorge (measurement) reminders (v1.17.1).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. Request
 * bodies come from the Zod validation module so the wire contract stays
 * single-source; the response DTO mirrors `src/lib/measurement-reminders/dto.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  createMeasurementReminderSchema,
  updateMeasurementReminderSchema,
  measurementReminderDto,
  measurementReminderCompletionDto,
} from "@/lib/validations/measurement-reminders";
import {
  dataEnvelope,
  errorEnvelope,
  recordRefusal,
  stdResponses,
} from "./shared";

const reminderNotFound = {
  "404": {
    description: "Measurement reminder not found / not owned.",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

export const measurementReminderPaths: NonNullable<ZodOpenApiObject["paths"]> =
  {
    "/api/measurement-reminders": {
      get: {
        tags: ["MeasurementReminders"],
        summary: "List Vorsorge reminders (v1.17.1)",
        description:
          "Returns the owner's live (non-tombstoned) Vorsorge reminders, sorted by server-computed nextDueAt ascending (nulls last). Each row carries the canonical nextDueAt the client renders without recomputing.",
        responses: {
          ...recordRefusal(),
          "200": {
            description: "The owner's measurement reminders.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  z.array(measurementReminderDto),
                  "MeasurementReminderListEnvelope",
                ),
              },
            },
          },
          ...stdResponses,
        },
      },
      post: {
        tags: ["MeasurementReminders"],
        summary: "Create a Vorsorge reminder (v1.17.1)",
        description:
          "Creates a reminder and computes its server-authoritative nextDueAt. Exactly one of intervalDays (rolling) or rrule (RFC-5545) is required. Wrapped in withIdempotency. 201 on insert.",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: createMeasurementReminderSchema },
          },
        },
        responses: {
          ...recordRefusal(),
          "201": {
            description: "Reminder created.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  measurementReminderDto,
                  "MeasurementReminderCreatedEnvelope",
                ),
              },
            },
          },
          ...stdResponses,
        },
      },
    },
    "/api/measurement-reminders/{id}": {
      get: {
        tags: ["MeasurementReminders"],
        summary: "Read a single Vorsorge reminder (v1.17.1)",
        description: "Owner-scoped; a cross-user or tombstoned id 404s.",
        requestParams: { path: z.object({ id: z.string() }) },
        responses: {
          ...recordRefusal(),
          "200": {
            description: "The reminder.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  measurementReminderDto,
                  "MeasurementReminderEnvelope",
                ),
              },
            },
          },
          ...reminderNotFound,
          ...stdResponses,
        },
      },
      patch: {
        tags: ["MeasurementReminders"],
        summary: "Edit a Vorsorge reminder (v1.17.1)",
        description:
          "Partial edit; omitted fields are left untouched. nextDueAt is recomputed server-side after the cadence merge. Owner-scoped.",
        requestParams: { path: z.object({ id: z.string() }) },
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: updateMeasurementReminderSchema },
          },
        },
        responses: {
          ...recordRefusal(),
          "200": {
            description: "Reminder updated.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  measurementReminderDto,
                  "MeasurementReminderPatchEnvelope",
                ),
              },
            },
          },
          ...reminderNotFound,
          ...stdResponses,
        },
      },
      delete: {
        tags: ["MeasurementReminders"],
        summary: "Soft-delete a Vorsorge reminder (v1.17.1)",
        description: "Sets deletedAt (tombstone). Idempotent. Owner-scoped.",
        requestParams: { path: z.object({ id: z.string() }) },
        responses: {
          ...recordRefusal(),
          "200": {
            description: "Soft-deleted.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  z.object({ deleted: z.boolean() }),
                  "MeasurementReminderDeleteEnvelope",
                ),
              },
            },
          },
          ...reminderNotFound,
          ...stdResponses,
        },
      },
    },
    "/api/measurement-reminders/{id}/satisfy": {
      post: {
        tags: ["MeasurementReminders"],
        summary: "Mark a Vorsorge reminder done (v1.17.1)",
        description:
          "Manual 'Erledigt': stamps lastSatisfiedAt = now and recomputes nextDueAt past now. Free-text reminders resolve only through this path; typed reminders also auto-resolve in the cron when a matching reading lands.",
        requestParams: { path: z.object({ id: z.string() }) },
        responses: {
          ...recordRefusal(),
          "200": {
            description: "Reminder satisfied; next-due re-anchored.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  measurementReminderDto,
                  "MeasurementReminderSatisfyEnvelope",
                ),
              },
            },
          },
          ...reminderNotFound,
          ...stdResponses,
        },
      },
    },
    "/api/measurement-reminders/{id}/complete": {
      post: {
        tags: ["MeasurementReminders"],
        summary: "Complete a Vorsorge reminder (v1.18.6)",
        description:
          "Explicit user-action completion (iOS #23): the app marks a reminder done server-side instead of only dismissing it locally. Routes through the same satisfaction primitive as the cron auto-resolve — stamps lastSatisfiedAt = now, re-anchors nextDueAt, fires no notification. Idempotent: completing an already-completed / auto-satisfied reminder returns 200 with completed=false. Owner-scoped.",
        requestParams: { path: z.object({ id: z.string() }) },
        responses: {
          ...recordRefusal(),
          "200": {
            description:
              "Completion applied (completed=true) or already-satisfied no-op (completed=false); reminder carries the canonical post-completion DTO.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  measurementReminderCompletionDto,
                  "MeasurementReminderCompleteEnvelope",
                ),
              },
            },
          },
          ...reminderNotFound,
          ...stdResponses,
        },
      },
    },
  };
