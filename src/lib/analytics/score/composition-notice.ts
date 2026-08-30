/**
 * Telling a person that the set behind their score changed.
 *
 * The delta guard already refuses to narrate a composition change as a
 * health event (`composition_changed`, `./composite.ts`), which is right and
 * is only half the job: it stops a false sentence and puts nothing in its
 * place. The number on the panel moves, and the reason it moved — sleep
 * rolled out of its window, a module went off, a source went quiet — is
 * nowhere on the surface. This resolves that reason.
 *
 * The comparison is against the last LOCAL DAY this account has a stored
 * score for, which is why `HealthScoreRecord` finally has a production
 * reader. Until now the table was written on every scored read and consumed
 * by nothing but backup and restore — precisely the write-only-column shape
 * the contributor notes call a liability, and it survived two releases
 * because nothing in the gate can notice a column that is only ever
 * written.
 *
 * Two changes deliberately do NOT raise this note, because they already
 * have one of their own and a person told twice about one event learns to
 * ignore both:
 *
 *   - the method moved (`scoreVersion`), and
 *   - the person changed their own recipe (`configVersion`).
 *
 * Either of those can move the composition as a side effect. What is left
 * after they are excluded is the case nobody chose and nobody was told
 * about, which is the one worth a sentence.
 *
 * Pure. The reader owns the query and the dismissal lookup; every decision
 * about whether there is anything to say is made here, over values, so it
 * can be tested without a database.
 */
import { healthScoreCompositionItemKey } from "@/lib/daily/priority-item-key";

import {
  orderedUniquePillars,
  type ScoreCompositionNotice,
  type ScorePillarId,
} from "./types";

/** The stored day the current composition is compared against. */
export interface StoredCompositionDay {
  /** The row's own `composition` column, unnarrowed. */
  composition: readonly string[];
  scoreVersion: number;
  /** Null on rows written before the column existed. */
  configVersion: number | null;
}

export interface CompositionNoticeInput {
  /** Today's composition, as the composite resolved it. */
  current: readonly ScorePillarId[];
  /** The most recent stored day BEFORE today, or null when there is none. */
  previous: StoredCompositionDay | null;
  /** The method identity today's score was computed under. */
  scoreVersion: number;
  /** The account's recipe version in force now. */
  configVersion: number;
}

/**
 * The item key the notice would carry, or null when there is nothing to
 * announce.
 *
 * Split out from the notice itself so the reader can look the dismissal up
 * in the same round trip it would have spent on the algorithm notice, and
 * so a caller never has to build a notice it is about to discard.
 */
export function compositionNoticeKey(
  input: CompositionNoticeInput,
): string | null {
  const { previous } = input;
  // Nothing to compare against. A first-ever scored day is a beginning, not
  // a change, and `first_eligibility_window` already narrates the missing
  // delta beside it.
  if (!previous) return null;
  // The method moved, or the person changed what counts. Both already raise
  // the versioned notice on the settings page.
  if (previous.scoreVersion !== input.scoreVersion) return null;
  if (
    previous.configVersion != null &&
    previous.configVersion !== input.configVersion
  ) {
    return null;
  }
  const current = orderedUniquePillars(input.current);
  const before = orderedUniquePillars(previous.composition);
  if (current.length === 0) return null;
  if (sameSet(before, current)) return null;
  return healthScoreCompositionItemKey(input.scoreVersion, current);
}

/**
 * Build the notice for a key `compositionNoticeKey` already approved.
 *
 * `dismissed` is the caller's lookup against the dismiss ledger, exactly as
 * the algorithm notice resolves it.
 */
export function buildCompositionNotice(
  input: CompositionNoticeInput,
  itemKey: string,
  dismissed: boolean,
): ScoreCompositionNotice {
  const current = orderedUniquePillars(input.current);
  const before = orderedUniquePillars(input.previous?.composition ?? []);
  const now = new Set<ScorePillarId>(current);
  const then = new Set<ScorePillarId>(before);
  return {
    itemKey,
    left: before.filter((id) => !now.has(id)),
    joined: current.filter((id) => !then.has(id)),
    dismissed,
  };
}

/**
 * Set equality over two registry-ordered lists.
 *
 * `orderedUniquePillars` already puts both in registry order and drops
 * anything outside the catalogue, so a length check plus a positional walk
 * is exact here — and a stored row naming a pillar the catalogue has since
 * retired compares as the absence it now is, rather than as a change every
 * single day forever.
 */
function sameSet(
  a: readonly ScorePillarId[],
  b: readonly ScorePillarId[],
): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
