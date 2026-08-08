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

/** Which seeded catalogue a key failed to resolve against. */
export type SkippedCatalogue =
  "cycleSymptom" | "illnessSymptom" | "moodFactor" | "moodTag";

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
