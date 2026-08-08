/**
 * Batch-ingest body parsing for `POST /api/workouts/batch`.
 *
 * The wire contract is `createBatchWorkoutSchema` and stays exactly that:
 * this module never widens what the endpoint accepts. What it changes is
 * WHERE one specific failure lands.
 *
 * A malformed field anywhere in the batch fails the whole call with a 400,
 * which is right for a client that got the shape wrong. The `samples`
 * array is the exception, because of how it arrives: the native client
 * re-posts workouts the server already stores purely to hand over their
 * heart-rate curve, sweeping years of history in batches of up to a
 * hundred. One session whose series came out of HealthKit malformed would
 * otherwise stall the entire sweep at a 400 the client cannot repair by
 * retrying — every other workout in that batch is fine and has nothing to
 * do with the bad one.
 *
 * So an entry whose `samples` array fails validation is refused on its
 * own, exactly the way an entry with an unusable `externalId` already is
 * (see `classifyExternalId` in the route), and the rest of the batch
 * lands. The refused entry is NOT stripped down and stored without its
 * series: the caller asked for the curve to be saved, so a half-write
 * would be a silent loss. It is reported back with its index so the
 * client knows which session to fix.
 *
 * Every other validation failure keeps failing the batch.
 */
import {
  createBatchWorkoutSchema,
  type CreateBatchWorkoutInput,
} from "@/lib/validations/workout";

/** Per-entry `reason` code for a `samples` array that failed validation. */
export const INVALID_SAMPLES_REASON = "invalid_samples";

export type WorkoutBatchParseResult =
  | {
      ok: true;
      data: CreateBatchWorkoutInput;
      /** Batch indices whose `samples` array was refused. */
      refusedSampleIndices: number[];
    }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Indices of entries whose ONLY problem is the `samples` array. An issue
 * path of `["workouts", 3, "samples", ...]` names entry 3; anything else
 * means the batch is broken in a way this path does not forgive.
 */
function collectSampleFailureIndices(
  issues: ReadonlyArray<{ path: PropertyKey[] }>,
): number[] | null {
  const indices = new Set<number>();
  for (const issue of issues) {
    const [root, index, field] = issue.path;
    if (root !== "workouts" || typeof index !== "number" || field !== "samples")
      return null;
    indices.add(index);
  }
  return indices.size > 0 ? [...indices].sort((a, b) => a - b) : null;
}

/**
 * Parses a batch body, refusing per entry when the only failures are
 * `samples` arrays. On that path the offending entries are re-parsed
 * without their series so the surviving entries keep their fully typed
 * shape; the caller drops the refused indices before any write.
 */
export function parseWorkoutBatch(rawBody: unknown): WorkoutBatchParseResult {
  const strict = createBatchWorkoutSchema.safeParse(rawBody);
  if (strict.success) {
    return { ok: true, data: strict.data, refusedSampleIndices: [] };
  }

  const refusedSampleIndices = collectSampleFailureIndices(strict.error.issues);
  if (
    refusedSampleIndices === null ||
    !isRecord(rawBody) ||
    !Array.isArray(rawBody.workouts)
  ) {
    return {
      ok: false,
      message: strict.error.issues[0]?.message ?? "Invalid batch",
    };
  }

  const refused = new Set(refusedSampleIndices);
  const stripped = {
    ...rawBody,
    workouts: rawBody.workouts.map((entry, index) => {
      if (!refused.has(index) || !isRecord(entry)) return entry;
      const { samples: _samples, ...rest } = entry;
      return rest;
    }),
  };

  const relaxed = createBatchWorkoutSchema.safeParse(stripped);
  if (!relaxed.success) {
    return {
      ok: false,
      message: relaxed.error.issues[0]?.message ?? "Invalid batch",
    };
  }
  return { ok: true, data: relaxed.data, refusedSampleIndices };
}
