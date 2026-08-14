/**
 * What a restore could not put back, and how much of it there was.
 *
 * Four of the restore's lookups resolve a key against a SEEDED CATALOGUE —
 * cycle symptoms, illness symptoms, rated mood factors and the mood tags a
 * person ticks present or absent. The catalogue is reference
 * data the instance owns, not data the file carries, so it legitimately drifts
 * between the day a backup is written and the day it is read: a key gets
 * renamed, a symptom is retired, the file is a year old, the instance is three
 * releases newer. That is the ordinary case for a backup, not a corrupt file.
 *
 * Each of those lookups used to throw, which rolled the whole transaction back
 * and answered 500 — one renamed symptom and the operator got none of the
 * account back. Before that they filtered the unresolvable key away and
 * reported success, which lost the same link with no trace at all. Neither is
 * honest: the first destroys a recoverable restore, the second hides a real
 * loss.
 *
 * So the unresolvable link is dropped and NAMED. This module is the naming.
 * Every drop lands here, and the accumulated report rides the restore response,
 * the audit row, and the wide event, so the count and the exact keys reach the
 * person who ran the restore instead of a log line nobody reads.
 *
 * What is dropped is deliberately narrow: one (row, symptom) association. The
 * day-log, the mood entry, the note, the flow, the temperature — everything the
 * row itself holds — comes back. A link table is the only place this applies,
 * because it is the only place where a value that will not resolve costs an
 * edge rather than a record.
 */

/**
 * Which lookup a key failed to resolve against.
 *
 * Four are seeded catalogues, as described above. The fifth, `visitReference`,
 * is a different kind of unresolvable and is here rather than in its own
 * mechanism because the cost and the honest response are identical: an edge is
 * lost, the record it hangs off survives, and the operator is told which one.
 * What it names is a row the file pointed at that the restore did not put
 * back — a reminder the file does not carry (a portable export omits
 * tombstoned ones since v1.37.20; before that no reminder travelled at all),
 * or a document, lab result or condition episode whose id a portable export
 * does not carry.
 *
 * The sixth, `vaccinationReference`, is the same kind as `visitReference` and
 * is kept separate rather than folded into it so the report says which part of
 * the record lost an edge. It names a row an immunization entry pointed at
 * that the restore did not put back — a booster reminder the file does not
 * carry, a practitioner or visit the file referenced without carrying, or a
 * scanned page whose id a portable export does not include.
 *
 * The seventh, `reminderReference`, is the same kind as the two above, for
 * the completion ledger (v1.37.20, #223 / iOS #68): a ledger row whose
 * reminder the file does not carry. The builder filters the ledger to carried
 * reminders at write time, so a file this release writes never trips it —
 * it exists for the hand-edited or truncated file, where inventing the
 * reminder and silently dropping the row are equally wrong.
 *
 * The eighth, `checkupClosure`, is not about a restore at all, and it borrows
 * this shape deliberately rather than growing a second reporting mechanism
 * beside it. The situation is the same one: something a write was asked to do
 * could not be done, the record itself survives, and the person is told which
 * one rather than left to assume it worked. It is filed when a delegate files
 * a visit against a preventive-care checkup their grant does not reach — the
 * visit saves, the checkup stays due, and the response says so.
 */
export type SkippedCatalogue =
  | "cycleSymptom"
  | "illnessSymptom"
  | "moodFactor"
  | "moodTag"
  | "visitReference"
  | "vaccinationReference"
  | "reminderReference"
  | "checkupClosure";

/** One key this instance does not know, and the links it cost. */
export interface SkippedCatalogueKey {
  catalogue: SkippedCatalogue;
  /** The key exactly as the file wrote it. Reported verbatim so an operator
   *  can grep the file for it and see which days it was on. */
  key: string;
  /** How many links referenced it — twelve day-logs is twelve, not one. */
  links: number;
}

/** Mutable accumulator threaded through one restore transaction. */
export type RestoreSkipLog = SkippedCatalogueKey[];

/** The report shape carried by the response, the audit row, and the UI. */
export interface RestoreSkipSummary {
  /** Distinct unknown keys, ordered by catalogue then key. */
  catalogueKeys: SkippedCatalogueKey[];
  /** Total links dropped across every catalogue. Zero means nothing was lost. */
  links: number;
}

/**
 * Record the keys a catalogue lookup could not resolve.
 *
 * `referenced` is the FLAT list of keys the file used, one entry per link, not
 * the deduplicated set the lookup queried with. A key that appears on twelve
 * day-logs cost twelve links, and reporting it as one would understate the loss
 * by a factor of twelve — which is the quiet-drop failure again, wearing a
 * number.
 */
export function recordUnknownKeys(
  log: RestoreSkipLog,
  catalogue: SkippedCatalogue,
  unresolved: readonly string[],
  referenced: readonly string[],
): void {
  for (const key of unresolved) {
    log.push({
      catalogue,
      key,
      links: referenced.filter((candidate) => candidate === key).length,
    });
  }
}

/** Fold the accumulator into the report the callers surface. */
export function summarizeRestoreSkips(log: RestoreSkipLog): RestoreSkipSummary {
  const catalogueKeys = [...log].sort((a, b) =>
    a.catalogue === b.catalogue
      ? a.key.localeCompare(b.key)
      : a.catalogue.localeCompare(b.catalogue),
  );
  return {
    catalogueKeys,
    links: catalogueKeys.reduce((total, entry) => total + entry.links, 0),
  };
}
