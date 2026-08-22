/**
 * OpenAPI route table — the onboarding wizard and the module tour.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * The request schemas come from `src/lib/onboarding/tour-progress.ts` and
 * `src/lib/validations/onboarding.ts` so the wire contract stays
 * single-source with the runtime parsers.
 *
 * Two generations of the same flow live side by side here, and a client
 * should pick one. `POST /api/onboarding/step` is the current wizard: four
 * ordered checkpoints, the fourth of which completes. `POST
 * /api/onboarding/complete` is the older single-shot path that stamps the
 * completion and takes whatever profile fields it was given. They write the
 * same column and refuse to co-operate — the step route's conditional update
 * requires `onboardingCompletedAt: null`, so a `complete` call mid-wizard
 * makes every remaining step 409.
 *
 * v1.18.6 — the resumable module-tour contract the iOS client mirrors:
 * a fire-and-forget progress checkpoint plus the coarse completion
 * flip. The resume point also rides `GET /api/auth/me` as
 * `onboardingTourProgress`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { tourProgressSchema } from "@/lib/onboarding/tour-progress";
import {
  onboardingCompleteSchema,
  onboardingStepSchema,
} from "@/lib/validations/onboarding";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

const tourProgressResource = tourProgressSchema.meta({
  id: "TourProgress",
  description:
    "Resumable module-tour progress point. `lastStopId` seeds the resume index; `status` is the running/terminal state.",
});

const tourUpdateRequest = z
  .object({
    completed: z
      .boolean()
      .optional()
      .describe(
        "Flip the coarse completion flag. `false` is a replay reset and clears the stored progress point.",
      ),
    outcome: z
      .enum(["completed", "skipped"])
      .optional()
      .describe("Informational — distinguishes reaching the end from a skip."),
    progress: tourProgressResource
      .optional()
      .describe(
        "Mid-tour resume checkpoint. May arrive alone or with `completed`.",
      ),
  })
  .meta({
    id: "TourUpdateRequest",
    description:
      "Update the module-tour state. Provide `completed` and/or `progress`.",
  });

const tourUpdateResponse = z
  .object({
    onboardingTourCompleted: z.boolean(),
    progress: tourProgressResource.nullable(),
  })
  .meta({
    id: "TourUpdateResponse",
    description:
      "The persisted completion flag and resume point after the write.",
  });

const disclaimerAckRequest = z
  .object({
    version: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "The disclaimer copy version the client rendered. A freshness signal only — the server pins and persists its own canonical version.",
      ),
  })
  .meta({
    id: "DisclaimerAckRequest",
    description:
      "Acknowledge the one-time medical disclaimer shown at onboarding.",
  });

const disclaimerAckResponse = z
  .object({
    acknowledgedVersion: z
      .string()
      .describe("The canonical disclaimer version the server stamped."),
  })
  .meta({
    id: "DisclaimerAckResponse",
    description: "The persisted disclaimer acknowledgment version.",
  });

const onboardingStepRequest = onboardingStepSchema.meta({
  id: "OnboardingStepRequest",
  description:
    "The wizard step being COMPLETED, 1–4. It must equal the stored step plus one — the server does not clamp or skip. `goals` rides the step-2 submit; every slug is checked against the closed set, so one unknown slug fails the whole request rather than being dropped.",
});

const onboardingStepResponse = z
  .object({
    step: z.number().int().describe("The stored step after the write."),
    onboardingCompletedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("Non-null once step 4 landed."),
  })
  .meta({ id: "OnboardingStepResponse" });

const onboardingCompleteRequest = onboardingCompleteSchema.meta({
  id: "OnboardingCompleteRequest",
  description:
    "Optional profile fields to save alongside the completion stamp. Every field is optional and only a truthy value is written — sending `heightCm: 0` or an empty `displayName` leaves the column alone rather than clearing it. There is no way to CLEAR a field through this endpoint. `dateOfBirth` is a free string parsed with `new Date(...)`: an unparseable value is silently ignored, not refused.",
});

export const onboardingPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/onboarding/step": {
    post: {
      tags: ["Onboarding"],
      summary: "Advance the onboarding wizard by one step",
      description:
        "Persists progress through the four-step wizard. The contract is strictly ordered: the submitted `step` must be exactly the stored step plus one, so a client cannot skip ahead or replay a step it already sent.\n\nSubmitting step 4 completes onboarding — the completion instant is stamped in the same write, the proxy-readable pending cookie is cleared so the next navigation stops redirecting to `/onboarding`, and the stored goal selection seeds the dashboard layout. That seed is ONE-TIME and conditional: it only runs while the layout column is still unset, so a person who already arranged their tiles is never clobbered, and a concurrent layout save that lands first wins.\n\nThe write is guarded on the state it validated, so two tabs submitting the same step do not both succeed — exactly one lands and the other gets 409.\n\nRate-limited to 30 writes per 10 minutes per user, which is generous for a four-step flow and tight enough to defang a stuck retry loop. Every accepted call writes an audit row. Cookie or wildcard Bearer; `userId` is never read from the body.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: onboardingStepRequest } },
      },
      responses: {
        "200": {
          description: "The stored step and completion stamp after the write.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                onboardingStepResponse,
                "OnboardingStepEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "The session's user row no longer exists. `meta.errorCode` = `onboarding.user.notFound`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The write was refused and nothing changed. `meta.errorCode` distinguishes three cases: `onboarding.step.completed` — onboarding is already finished, so the wizard has nothing left to advance; `onboarding.step.outOfOrder` — the submitted step is not the stored step plus one, and the message names the current step; `onboarding.step.concurrent` — the row moved between the check and the write, which is what a second tab sees.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "`Content-Type` is not `application/json`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The body did not validate. `meta.errorCode` = `onboarding.step.invalid`. Single-message, not the multi-issue envelope — the per-field detail is not on the wire.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 30 onboarding writes in 10 minutes. `meta.errorCode` = `onboarding.step.rateLimited`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/onboarding/complete": {
    post: {
      tags: ["Onboarding"],
      summary: "Stamp onboarding as complete (legacy single-shot path)",
      description:
        "Marks onboarding finished and saves whatever profile fields came with it, then clears the proxy-readable pending cookie so the next navigation stops redirecting to `/onboarding`.\n\nThe older sibling of `POST /api/onboarding/step`. It is unconditional in a way the step route is not: it stamps the completion whatever the stored step is, it re-stamps on every call rather than refusing a second one, and it writes no audit row and enforces no rate limit of its own. It also does NOT seed the dashboard from the goal selection — that only happens on the step route's completing call.\n\nCalling this mid-wizard makes every remaining `POST /api/onboarding/step` answer 409 `onboarding.step.completed`, because that route's guarded update requires the completion stamp to still be null.\n\nCookie or wildcard Bearer; `userId` is never read from the body.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: onboardingCompleteRequest } },
      },
      responses: {
        "200": {
          description:
            "Onboarding stamped complete. The body is the fixed `{ completed: true }` acknowledgement — it does not echo what was saved.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ completed: z.literal(true) }),
                "OnboardingCompleteEnvelope",
              ),
            },
          },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "`Content-Type` is not `application/json`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The body did not validate. `meta.errorCode` = `onboarding.complete.invalid`. Single-message, not the multi-issue envelope.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/onboarding/disclaimer": {
    post: {
      tags: ["Onboarding"],
      summary: "Acknowledge the one-time medical disclaimer",
      description:
        "Stamps the user's medical-disclaimer acknowledgment. Idempotent: a repeat acknowledgment of the same version refreshes the timestamp. The body version is a freshness signal so a stale shell cannot record copy it never rendered; the server persists its own canonical version.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: disclaimerAckRequest } },
      },
      responses: {
        "200": {
          description: "Disclaimer acknowledged.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                disclaimerAckResponse,
                "DisclaimerAckEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/onboarding/tour": {
    post: {
      tags: ["Onboarding"],
      summary: "Update module-tour completion + resume point",
      description:
        "Persists the module-tour state. The client posts a fire-and-forget `progress` checkpoint on each step so a reload resumes at the right module, and a terminal `completed:true` with `outcome` when the tour ends. `completed:false` is a replay reset that also clears the resume point.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: tourUpdateRequest } },
      },
      responses: {
        "200": {
          description: "Tour state updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(tourUpdateResponse, "TourUpdateEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
