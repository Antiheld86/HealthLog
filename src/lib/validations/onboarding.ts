/**
 * Request schemas for the two onboarding write endpoints.
 *
 * They live outside the route files for the same reason
 * `src/lib/validations/about-me.ts` does: a route module may only export
 * handlers plus the Next.js route config, so the OpenAPI registry cannot
 * import a schema declared inside one. Keeping the shapes here lets the
 * published contract and the runtime parser be the same object rather than
 * two hand-kept copies.
 *
 * Prisma-free by construction — `@/lib/onboarding/goals` is pure data — so
 * the generator script can pull them in without dragging the server graph
 * along.
 */
import { z } from "zod/v4";

import { ONBOARDING_GOAL_SLUGS } from "@/lib/onboarding/goals";

/**
 * `POST /api/onboarding/step` — the step-by-step wizard checkpoint.
 *
 * `step` is the step being COMPLETED and must equal the stored step plus one;
 * the route refuses anything else with 409 rather than clamping. `goals`
 * rides the step-2 submit and is validated against the closed slug set, so an
 * unknown slug fails the whole request instead of being silently dropped.
 */
export const onboardingStepSchema = z.object({
  step: z.number().int().min(1).max(4),
  goals: z
    .array(z.enum(ONBOARDING_GOAL_SLUGS))
    .max(ONBOARDING_GOAL_SLUGS.length)
    .optional(),
});

export type OnboardingStepInput = z.infer<typeof onboardingStepSchema>;

/**
 * `POST /api/onboarding/complete` — the legacy single-shot completion path.
 *
 * Every field is optional: the endpoint's job is the completion stamp, and
 * the profile fields are whatever the wizard happened to collect. A field
 * that parses but is falsy (an empty `displayName`, `heightCm: 0`) is not
 * written — the route only assigns truthy values.
 */
export const onboardingCompleteSchema = z.object({
  displayName: z.string().trim().min(1).max(50).optional(),
  heightCm: z.number().min(50).max(300).optional(),
  dateOfBirth: z.string().optional(),
  // The same three values the profile schema stores. A narrower enum here
  // rejected the whole onboarding submission over a field the account is
  // allowed to hold, and left the value unrecordable until the person found
  // the setting again afterwards.
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
});

export type OnboardingCompleteInput = z.infer<typeof onboardingCompleteSchema>;
