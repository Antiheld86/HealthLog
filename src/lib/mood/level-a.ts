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

/**
 * Level-A values as they are written to `MoodEntry`.
 *
 * A1 is always stated, because it is always derivable from the label. The
 * other four are present only when the request carried them: an absent key
 * means the caller said nothing about that dimension, and on an upsert's
 * `update:` arm saying nothing has to leave the stored answer alone.
 */
export interface LevelAColumns {
  moodA1: number;
  stressA2?: number | null;
  energyA3?: number | null;
  connectionA4?: number | null;
  stabilityA5?: number | null;
}

/**
 * The five columns for a write of `mood`, with any explicit client value
 * winning over the derivation.
 *
 * A client that sends only a label gets the derived A1 and says nothing at all
 * about the other four. A client that sends `a1` gets its own number — that is
 * what makes the detail sliders a real capture surface rather than a
 * suggestion the server overrides on the way to the database.
 *
 * **A2 to A5 are omitted when the request did not carry them, and that is the
 * point.** The callers are upserts, so this same object feeds an `update:`
 * arm: a phone re-posting an entry it holds — the label, the timestamp, the
 * tags, and no sliders, because its own build has none — must not blank the
 * stress and energy somebody answered on the web. Absence in a request means
 * "nothing to say", never "set this to nothing". Clearing an answer is what an
 * explicit `null` is for, and it travels here as a stated null.
 *
 * The asymmetry with A1 is deliberate rather than an oversight. A1 can always
 * be derived from the label the request already carries, so there is no state
 * in which restating it loses information; the other four have no such source,
 * and a value invented for them would be indistinguishable from one somebody
 * gave — which would poison the trend and anything later trained on it.
 *
 * On the `create:` arm an omitted column lands as NULL anyway, so one object
 * serves both arms. Callers whose write semantics are per-field rather than
 * whole-row (the edit route) build their own object and use `deriveA1`.
 */
export function levelAForWrite(
  mood: string,
  explicit?: LevelAInput,
): LevelAColumns {
  // Field by field, never a spread of the parsed body.
  return {
    // An explicit null falls back to the derivation rather than clearing: an
    // entry always carries a pleasantness value, because the five-point label
    // it was saved with always implies one.
    moodA1: explicit?.a1 ?? getA1ForMood(mood),
    ...(explicit?.a2 === undefined ? {} : { stressA2: explicit.a2 }),
    ...(explicit?.a3 === undefined ? {} : { energyA3: explicit.a3 }),
    ...(explicit?.a4 === undefined ? {} : { connectionA4: explicit.a4 }),
    ...(explicit?.a5 === undefined ? {} : { stabilityA5: explicit.a5 }),
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

/** The five columns as they sit on a `MoodEntry` row. */
export interface LevelARow {
  moodA1: number | null;
  stressA2: number | null;
  energyA3: number | null;
  connectionA4: number | null;
  stabilityA5: number | null;
}

/**
 * Turn a stored row's five columns into the wire keys the client sends.
 *
 * A read that answered `moodA1` while the write took `a1` would leave every
 * form mapping the pair by hand, and one of them would eventually map it
 * wrong. The names match in both directions.
 */
export function levelAForWire(row: LevelARow): LevelAWire {
  return {
    a1: row.moodA1,
    a2: row.stressA2,
    a3: row.energyA3,
    a4: row.connectionA4,
    a5: row.stabilityA5,
  };
}

/**
 * A row shaped for a response: the five columns replaced by their wire keys,
 * not joined by them.
 *
 * The mood routes spread the whole row into their responses, so simply adding
 * the wire keys left every entry carrying the same five values twice under two
 * spellings. Two names for one number is a decision nobody made, and the one a
 * client picks is the one it gets stuck with. This strips the column spelling
 * and keeps the wire one, which is the spelling the write path accepts.
 */
export function shapeLevelA<T extends LevelARow>(
  row: T,
): Omit<T, keyof LevelARow> & LevelAWire {
  const { moodA1, stressA2, energyA3, connectionA4, stabilityA5, ...rest } =
    row;
  return {
    ...rest,
    ...levelAForWire({
      moodA1,
      stressA2,
      energyA3,
      connectionA4,
      stabilityA5,
    }),
  };
}
