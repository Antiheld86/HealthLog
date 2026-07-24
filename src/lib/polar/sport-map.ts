/**
 * Polar exercise sport (`sport` coarse enum, `detailed_sport_info` granular
 * enum) → HealthLog canonical `WorkoutSportType`.
 *
 * Polar is a WORKOUT source that ships two sport fields on every exercise: a
 * coarse `sport` (e.g. `RUNNING`, `CYCLING`) and a granular
 * `detailed_sport_info` (e.g. `TRAIL_RUNNING`, `INDOOR_CYCLING`). The mapper
 * prefers the granular value, falls back to the coarse one, then to `"other"`,
 * so a row always lands in a canonical bucket the read-time picker can cluster
 * — the raw labels are kept in `Workout.metadata` for provenance, never written
 * to `sportType` directly. This mirrors the Strava / WHOOP / Fitbit / Google
 * Health mappers; shipping a workout source WITHOUT this normalisation is the
 * exact Strava launch bug (`src/lib/strava/sport-map.ts:1-58`) where generic
 * rows collapsed same-source back-to-back sessions.
 *
 * `POLAR_SPORT_TABLE` is the single source of truth — `POLAR_SPORT_MAP` derives
 * from it. Keep this list — and only this list — in sync when Polar adds a
 * sport. Both the coarse and granular Polar enum values are listed under the
 * same normalised key space, so either field resolves through one lookup.
 *
 * Bucket choices for sports with no clean 1:1 canonical match follow the SAME
 * judgment calls the Strava table documents, so a Polar row and a Strava row of
 * the same real-world sport land in the same bucket:
 *   - paddle sports (canoe, kayak, stand-up paddling) → `"rowing"`.
 *   - racket / paddle-court sports (badminton, padel, squash, table tennis,
 *     tennis, pickleball, racquetball) → `"tennis"`.
 *   - functional / mixed-modal + climbing (functional training, crossfit,
 *     climbing) → `"crossTraining"`.
 *   - recovery / mobility work (pilates, stretching, mobility, physiotherapy)
 *     → `"mindAndBody"`.
 *   - e-bike / mountain-bike / indoor cycling with no dedicated bucket →
 *     `"cycling"`.
 *   - snow-sliding sports (alpine / cross-country / backcountry ski, snowboard,
 *     roller ski, skating) → `"other"`, same as Strava/WHOOP.
 *   - team / niche sports with no matching bucket (ice hockey, floorball,
 *     handball, volleyball, martial arts, boxing, water sports, surfing,
 *     sailing, skateboarding, triathlon, group exercise, generic
 *     indoor/outdoor) → `"other"` — the row still persists, just outside a
 *     canonical sport bucket, matching an unmapped Strava/Fitbit activity.
 *
 * The Polar sport enum is broad and not published as a single machine-readable
 * list, so this table covers the documented profiles; any value it hasn't
 * caught up with lands on `"other"` (the row persists), which is the defensive
 * default the design mandates.
 */
import type { WorkoutSportType } from "@/lib/validations/workout";

interface PolarSportTableRow {
  /** A Polar `sport` or `detailed_sport_info` enum value (UPPER_SNAKE_CASE). */
  name: string;
  canonical: WorkoutSportType;
}

/**
 * Polar sport value → canonical bucket. Grouped by canonical bucket for
 * readability; both the coarse `sport` values and the common
 * `detailed_sport_info` values share this one key space (the normaliser folds
 * case + strips separators so `"TRAIL_RUNNING"` and `"trailrunning"` collide).
 */
export const POLAR_SPORT_TABLE: readonly PolarSportTableRow[] = [
  // ── running ──
  { name: "RUNNING", canonical: "running" },
  { name: "JOGGING", canonical: "running" },
  { name: "ROAD_RUNNING", canonical: "running" },
  { name: "TRACK_AND_FIELD_RUNNING", canonical: "running" },
  { name: "TRAIL_RUNNING", canonical: "running" },
  { name: "TREADMILL_RUNNING", canonical: "running" },
  { name: "ULTRA_RUNNING", canonical: "running" },
  // ── cycling ──
  { name: "CYCLING", canonical: "cycling" },
  { name: "ROAD_BIKING", canonical: "cycling" },
  { name: "INDOOR_CYCLING", canonical: "cycling" },
  { name: "MOUNTAIN_BIKING", canonical: "cycling" },
  { name: "GRAVEL_CYCLING", canonical: "cycling" },
  { name: "E_BIKE", canonical: "cycling" },
  { name: "EBIKE", canonical: "cycling" },
  { name: "HANDCYCLING", canonical: "cycling" },
  // ── walking ──
  { name: "WALKING", canonical: "walking" },
  { name: "NORDIC_WALKING", canonical: "walking" },
  // ── hiking ──
  { name: "HIKING", canonical: "hiking" },
  { name: "TREKKING", canonical: "hiking" },
  { name: "MOUNTAIN_HIKING", canonical: "hiking" },
  { name: "SNOWSHOE_TREKKING", canonical: "hiking" },
  // ── swimming ──
  { name: "SWIMMING", canonical: "swimming" },
  { name: "POOL_SWIMMING", canonical: "swimming" },
  { name: "OPEN_WATER_SWIMMING", canonical: "swimming" },
  // ── rowing / paddle ──
  { name: "ROWING", canonical: "rowing" },
  { name: "INDOOR_ROWING", canonical: "rowing" },
  { name: "KAYAKING", canonical: "rowing" },
  { name: "CANOEING", canonical: "rowing" },
  { name: "STAND_UP_PADDLING", canonical: "rowing" },
  { name: "PADDLING", canonical: "rowing" },
  // ── elliptical / stair ──
  { name: "ELLIPTICAL", canonical: "elliptical" },
  { name: "CROSS_TRAINER", canonical: "elliptical" },
  { name: "STAIR_CLIMBING", canonical: "stairClimber" },
  { name: "STEP_MACHINE", canonical: "stairClimber" },
  // ── strength ──
  { name: "STRENGTH_TRAINING", canonical: "strength" },
  { name: "CORE", canonical: "strength" },
  // ── HIIT ──
  { name: "HIIT", canonical: "hiit" },
  { name: "HIGH_INTENSITY_INTERVAL_TRAINING", canonical: "hiit" },
  { name: "CIRCUIT_TRAINING", canonical: "hiit" },
  // ── functional / cross-training + climbing ──
  { name: "FUNCTIONAL_TRAINING", canonical: "crossTraining" },
  { name: "CROSSFIT", canonical: "crossTraining" },
  { name: "CLIMBING", canonical: "crossTraining" },
  { name: "INDOOR_CLIMBING", canonical: "crossTraining" },
  { name: "ROCK_CLIMBING", canonical: "crossTraining" },
  // ── yoga / mind & body ──
  { name: "YOGA", canonical: "yoga" },
  { name: "PILATES", canonical: "mindAndBody" },
  { name: "STRETCHING", canonical: "mindAndBody" },
  { name: "MOBILITY_STATIC", canonical: "mindAndBody" },
  { name: "MOBILITY_DYNAMIC", canonical: "mindAndBody" },
  { name: "PHYSICAL_THERAPY", canonical: "mindAndBody" },
  // ── dance ──
  { name: "DANCE", canonical: "dance" },
  { name: "DANCING", canonical: "dance" },
  { name: "ZUMBA", canonical: "dance" },
  { name: "AEROBICS", canonical: "dance" },
  // ── golf ──
  { name: "GOLF", canonical: "golf" },
  // ── racket / paddle-court ──
  { name: "TENNIS", canonical: "tennis" },
  { name: "TABLE_TENNIS", canonical: "tennis" },
  { name: "BADMINTON", canonical: "tennis" },
  { name: "SQUASH", canonical: "tennis" },
  { name: "PADEL", canonical: "tennis" },
  { name: "PICKLEBALL", canonical: "tennis" },
  { name: "RACQUETBALL", canonical: "tennis" },
  // ── basketball / soccer ──
  { name: "BASKETBALL", canonical: "basketball" },
  { name: "SOCCER", canonical: "soccer" },
  { name: "FOOTBALL", canonical: "soccer" },
  // ── other: snow-sliding ──
  { name: "ALPINE_SKIING", canonical: "other" },
  { name: "CROSS_COUNTRY_SKIING_CLASSIC", canonical: "other" },
  { name: "CROSS_COUNTRY_SKIING_FREESTYLE", canonical: "other" },
  { name: "BACKCOUNTRY_SKIING", canonical: "other" },
  { name: "SNOWBOARDING", canonical: "other" },
  { name: "ROLLER_SKIING_CLASSIC", canonical: "other" },
  { name: "ROLLER_SKIING_FREESTYLE", canonical: "other" },
  { name: "SKATING", canonical: "other" },
  { name: "ICE_SKATING", canonical: "other" },
  // ── other: team / niche / catch-all ──
  { name: "VOLLEYBALL", canonical: "other" },
  { name: "ICE_HOCKEY", canonical: "other" },
  { name: "FLOORBALL", canonical: "other" },
  { name: "HANDBALL", canonical: "other" },
  { name: "MARTIAL_ARTS", canonical: "other" },
  { name: "BOXING", canonical: "other" },
  { name: "KICKBOXING", canonical: "other" },
  { name: "WATER_SPORTS", canonical: "other" },
  { name: "SURFING", canonical: "other" },
  { name: "WINDSURFING", canonical: "other" },
  { name: "KITESURFING", canonical: "other" },
  { name: "SAILING", canonical: "other" },
  { name: "SKATEBOARDING", canonical: "other" },
  { name: "TRIATHLON", canonical: "other" },
  { name: "GROUP_EXERCISE", canonical: "other" },
  { name: "OTHER_INDOOR", canonical: "other" },
  { name: "OTHER_OUTDOOR", canonical: "other" },
] as const;

/**
 * Lowercase and strip every character outside `[a-z0-9]`. Polar's sport values
 * are UPPER_SNAKE_CASE with underscores (`"TRAIL_RUNNING"`), so this folds case
 * and drops the separators; applied to BOTH the table names (at build time) and
 * the incoming raw value (at lookup time), so a stray space / hyphen / casing
 * variant still resolves to the same key.
 */
export function normalisePolarSportKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export const POLAR_SPORT_MAP: ReadonlyMap<string, WorkoutSportType> = new Map(
  POLAR_SPORT_TABLE.map((row) => [
    normalisePolarSportKey(row.name),
    row.canonical,
  ]),
);

/**
 * Resolve a Polar exercise's sport to a canonical `WorkoutSportType`. Prefers
 * the granular `detailed_sport_info`; when that is absent, blank, or
 * unrecognised, falls back to the coarse `sport`; defaults to `"other"` for
 * anything absent, blank, or unrecognised (a Polar-added sport this table
 * hasn't caught up with yet). NEVER returns a raw Polar label.
 */
export function mapPolarSportType(
  detailed: string | null | undefined,
  coarse: string | null | undefined,
): WorkoutSportType {
  const fromDetailed = lookup(detailed);
  if (fromDetailed) return fromDetailed;
  const fromCoarse = lookup(coarse);
  if (fromCoarse) return fromCoarse;
  return "other";
}

function lookup(raw: string | null | undefined): WorkoutSportType | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return POLAR_SPORT_MAP.get(normalisePolarSportKey(raw));
}
