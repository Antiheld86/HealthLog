/**
 * The one place a mood write resolves its five level-A values.
 *
 * Five writers reach `MoodEntry`, and every one of them sends exactly what it
 * sent before this existed: a five-point label and nothing else. The server
 * derives pleasantness (A1) from that label so a quick check-in is a full
 * entry rather than a degraded one, and so a Telegram row, an imported row and
 * a row typed into the web form all carry the same value for the same day.
 *
 * The other four are never derived. There is nothing in a five-point label to
 * derive stress, energy, connectedness or stability from, and a fabricated
 * value would read as an answer nobody gave — it would poison the trend and
 * any later model trained on these columns. They stay NULL until somebody
 * moves the slider.
 */
import { getA1ForMood } from "@/lib/validations/mood";

/** Level-A values as a client may send them, all optional. */
export interface LevelAInput {
  a1?: number | null;
  a2?: number | null;
  a3?: number | null;
  a4?: number | null;
  a5?: number | null;
}

/** Level-A values as they are written to `MoodEntry`. */
export interface LevelAColumns {
  moodA1: number | null;
  stressA2: number | null;
  energyA3: number | null;
  connectionA4: number | null;
  stabilityA5: number | null;
}

/**
 * The five columns for a write of `mood`, with any explicit client value
 * winning over the derivation.
 *
 * A client that sends only a label gets the derived A1 and four NULLs. A
 * client that sends `a1` gets its own number — that is what makes the detail
 * sliders a real capture surface rather than a suggestion the server overrides
 * on the way to the database.
 *
 * Every field is stated explicitly, including the NULLs, because the callers
 * are upserts: on the `update:` arm an omitted field keeps a value from an
 * earlier post, and a stale stress reading sitting beside a mood the user just
 * changed is exactly the mismatch these columns exist to avoid. Callers whose
 * write semantics are per-field rather than whole-row (the PATCH route) build
 * their own object and use `deriveA1` directly.
 */
export function levelAForWrite(
  mood: string,
  explicit?: LevelAInput,
): LevelAColumns {
  return {
    moodA1: explicit?.a1 ?? getA1ForMood(mood),
    stressA2: explicit?.a2 ?? null,
    energyA3: explicit?.a3 ?? null,
    connectionA4: explicit?.a4 ?? null,
    stabilityA5: explicit?.a5 ?? null,
  };
}

/** A1 for a five-point label — the derivation on its own, for writers that carry no level-A input. */
export function deriveA1(mood: string): number {
  return getA1ForMood(mood);
}

/** The five columns as a client reads them back. */
export interface LevelAWire {
  a1: number | null;
  a2: number | null;
  a3: number | null;
  a4: number | null;
  a5: number | null;
}

/**
 * Turn a stored row's five columns into the wire keys the client sends.
 *
 * A read that answered `moodA1` while the write took `a1` would leave every
 * form mapping the pair by hand, and one of them would eventually map it
 * wrong. The names match in both directions.
 */
export function levelAForWire(row: {
  moodA1: number | null;
  stressA2: number | null;
  energyA3: number | null;
  connectionA4: number | null;
  stabilityA5: number | null;
}): LevelAWire {
  return {
    a1: row.moodA1,
    a2: row.stressA2,
    a3: row.energyA3,
    a4: row.connectionA4,
    a5: row.stabilityA5,
  };
}
