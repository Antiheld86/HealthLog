/**
 * CoachScopeSource → MeasurementType[] mapping.
 *
 * Extracted out of `snapshot.ts` (where it lived as a function-local literal)
 * so the availability probe reads the SAME table the windowed snapshot read
 * builds its `WHERE type IN (…)` from. The probe answers "does this domain
 * exist at all, outside the window?" — if it resolved its types from a second
 * copy of this table, a new metric could be windowed by one map and probed by
 * the other, and the two would disagree silently. One table, two readers.
 *
 * `mood`, `compliance`, and `workouts` map to no `MeasurementType` because they
 * read separate models (MoodEntry / MedicationIntakeEvent / Workout); the
 * availability probe carries its own subject kinds for those. `glucose` also
 * reads `Measurement` but needs the `glucoseContext` column, so its snapshot
 * block is built separately rather than from the shared rows.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import type { CoachScopeSource } from "@/lib/ai/coach/types";

export const COACH_SOURCE_MEASUREMENT_TYPES: Readonly<
  Record<CoachScopeSource, readonly MeasurementType[]>
> = {
  bp: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
  weight: ["WEIGHT"],
  pulse: ["PULSE"],
  mood: [],
  compliance: [],
  // v1.30.4 (HRV union) — Oura / Polar / WHOOP write nightly HRV as RMSSD
  // (`HRV_RMSSD`), never SDNN (`HEART_RATE_VARIABILITY`, Apple / Fitbit).
  // The app's HRV surface already unions both (`sub-page-metric.ts`);
  // resolving SDNN alone here made a ring/strap-only user's Coach context
  // + the `get_metric_series`/rich-read MCP paths report a false
  // `{present:false}` for HRV even though the app charts it.
  hrv: ["HEART_RATE_VARIABILITY", "HRV_RMSSD"],
  sleep: ["SLEEP_DURATION"],
  resting_hr: ["RESTING_HEART_RATE"],
  steps: ["ACTIVITY_STEPS"],
  active_energy: ["ACTIVE_ENERGY_BURNED"],
  flights: ["FLIGHTS_CLIMBED"],
  distance: ["WALKING_RUNNING_DISTANCE"],
  vo2_max: ["VO2_MAX"],
  body_temp: ["BODY_TEMPERATURE"],
  // ── cardio composition / vascular ──
  walking_hr: ["WALKING_HEART_RATE_AVERAGE"],
  respiratory_rate: ["RESPIRATORY_RATE"],
  spo2: ["OXYGEN_SATURATION"],
  pulse_wave_velocity: ["PULSE_WAVE_VELOCITY"],
  vascular_age: ["VASCULAR_AGE"],
  // ── body composition ──
  body_fat: ["BODY_FAT"],
  fat_mass: ["FAT_MASS"],
  fat_free_mass: ["FAT_FREE_MASS"],
  muscle_mass: ["MUSCLE_MASS"],
  lean_body_mass: ["LEAN_BODY_MASS"],
  bone_mass: ["BONE_MASS"],
  total_body_water: ["TOTAL_BODY_WATER"],
  bmi: ["BODY_MASS_INDEX"],
  visceral_fat: ["VISCERAL_FAT"],
  // ── metabolic — built via the dedicated glucose branch ──
  glucose: ["BLOOD_GLUCOSE"],
  // ── mobility & gait ──
  walking_steadiness: ["WALKING_STEADINESS"],
  walking_asymmetry: ["WALKING_ASYMMETRY"],
  walking_double_support: ["WALKING_DOUBLE_SUPPORT"],
  walking_step_length: ["WALKING_STEP_LENGTH"],
  walking_speed: ["WALKING_SPEED"],
  // ── environment / exposure ──
  audio_env: ["AUDIO_EXPOSURE_ENV"],
  audio_headphone: ["AUDIO_EXPOSURE_HEADPHONE"],
  audio_event: ["AUDIO_EXPOSURE_EVENT"],
  daylight: ["TIME_IN_DAYLIGHT"],
  skin_temp: ["SKIN_TEMPERATURE"],
  // ── workouts — read from the Workout model, not Measurement ──
  workouts: [],
};
