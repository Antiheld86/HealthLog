import { z } from "zod/v4";

export const HEALTH_PROFILE_AI_SECTIONS = [
  "ABOUT_ME",
  "CONDITIONS",
  "ALLERGIES",
  "COACH_FOCUS",
  "FAMILY_HISTORY",
  "SMOKING_STATUS",
  "ALCOHOL_PATTERN",
  "SHIFT_SCHEDULE",
] as const;

export type HealthProfileAiSection =
  (typeof HEALTH_PROFILE_AI_SECTIONS)[number];

export const DEFAULT_HEALTH_PROFILE_AI_SECTIONS = [
  "ABOUT_ME",
  "CONDITIONS",
  "ALLERGIES",
  "COACH_FOCUS",
  "FAMILY_HISTORY",
  "SMOKING_STATUS",
  "ALCOHOL_PATTERN",
  "SHIFT_SCHEDULE",
] as const satisfies readonly HealthProfileAiSection[];

export const healthProfileAiSectionSchema = z.enum(HEALTH_PROFILE_AI_SECTIONS);

export const SMOKING_STATUS_VALUES = ["NEVER", "FORMER", "CURRENT"] as const;
export const ALCOHOL_PATTERN_VALUES = [
  "NONE",
  "OCCASIONAL",
  "WEEKLY",
  "MOST_DAYS",
] as const;
export const SHIFT_SCHEDULE_VALUES = [
  "NONE",
  "FIXED_SHIFT",
  "ROTATING",
] as const;

export const HEALTH_PROFILE_FACT_KINDS = [
  "SMOKING_STATUS",
  "ALCOHOL_PATTERN",
  "SHIFT_SCHEDULE",
] as const;

export type HealthProfileFactKind = (typeof HEALTH_PROFILE_FACT_KINDS)[number];
export type SmokingStatusValue = (typeof SMOKING_STATUS_VALUES)[number];
export type AlcoholPatternValue = (typeof ALCOHOL_PATTERN_VALUES)[number];
export type ShiftScheduleValue = (typeof SHIFT_SCHEDULE_VALUES)[number];
export type HealthProfileFactValue =
  SmokingStatusValue | AlcoholPatternValue | ShiftScheduleValue;
export const HEALTH_PROFILE_FACT_VALUES: Record<
  HealthProfileFactKind,
  Readonly<Record<string, true>>
> = {
  SMOKING_STATUS: { NEVER: true, FORMER: true, CURRENT: true },
  ALCOHOL_PATTERN: {
    NONE: true,
    OCCASIONAL: true,
    WEEKLY: true,
    MOST_DAYS: true,
  },
  SHIFT_SCHEDULE: { NONE: true, FIXED_SHIFT: true, ROTATING: true },
};
export const healthProfileFactKindSchema = z.enum(HEALTH_PROFILE_FACT_KINDS);

export function isHealthProfileFactValue(
  kind: HealthProfileFactKind,
  value: string,
): value is HealthProfileFactValue {
  return HEALTH_PROFILE_FACT_VALUES[kind][value] === true;
}

export const healthProfileFactWriteSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("SMOKING_STATUS"),
    value: z.enum(SMOKING_STATUS_VALUES),
  }),
  z.object({
    kind: z.literal("ALCOHOL_PATTERN"),
    value: z.enum(ALCOHOL_PATTERN_VALUES),
  }),
  z.object({
    kind: z.literal("SHIFT_SCHEDULE"),
    value: z.enum(SHIFT_SCHEDULE_VALUES),
  }),
]);

export const healthProfileFactCorrectionSchema = z.object({
  value: z.string().trim().min(1),
});

export function validateCorrectedFactValue(
  kind: HealthProfileFactKind,
  value: string,
): HealthProfileFactValue | null {
  return isHealthProfileFactValue(kind, value) ? value : null;
}

export const healthProfileFactDtoSchema = z.object({
  id: z.string(),
  kind: healthProfileFactKindSchema,
  value: z.string().nullable(),
  unreadable: z.boolean(),
  validFrom: z.iso.datetime({ offset: true }),
  validUntil: z.iso.datetime({ offset: true }).nullable(),
  provenance: z.enum(["USER_REPORTED", "USER_CORRECTION"]),
  supersededByRevisionId: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const healthProfileFactsResponseSchema = z.object({
  current: z.object({
    SMOKING_STATUS: healthProfileFactDtoSchema.nullable(),
    ALCOHOL_PATTERN: healthProfileFactDtoSchema.nullable(),
    SHIFT_SCHEDULE: healthProfileFactDtoSchema.nullable(),
  }),
  history: z.array(healthProfileFactDtoSchema),
});

export const removedHealthProfileFactSchema = z.object({
  id: z.string(),
  kind: healthProfileFactKindSchema,
  removedAt: z.iso.datetime({ offset: true }),
});
