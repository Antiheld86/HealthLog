/**
 * From parsed doses to the queued import — medication matching and the payload.
 *
 * Pure: the caller passes the medications the account already holds, so the
 * whole matching decision is testable without a database and the route stays a
 * thin shell over it.
 *
 * The one policy decision that lives here is that a medication is never created
 * from an import file. See {@link planAutoExportImport}.
 */
import type {
  MedicationImportEntry,
  MedicationImportSkipCounts,
  MedicationImportSkipDetail,
  MedicationImportSkipReason,
} from "@/lib/jobs/medication-intake-import";
import { appendMedicationImportSkipDetails } from "@/lib/jobs/medication-intake-import";

import { medicationImportIdempotencyKey } from "@/lib/medications/intake-import-payload";
import { normaliseMedicationName } from "./auto-export-format";
import type {
  AutoExportDose,
  AutoExportParseOutcome,
} from "./auto-export-parse";

/** A medication already on the record, as the matcher needs to see it. */
export interface MedicationMatchCandidate {
  id: string;
  name: string;
  /**
   * Non-null marks the medication a read-only mirror of an external list (the
   * Apple Health medications sync). Such a row is source-exclusive by policy —
   * only dose events from that same source attach to it — so an import cannot
   * write to it.
   */
  externalSource: string | null;
}

export interface AutoExportPlan {
  /** What the worker will attempt to write, in file order. */
  entries: MedicationImportEntry[];
  /**
   * Rows refused before the queue, by reason. Seeded into the job's progress so
   * the final count the person reads covers the whole file and not just the part
   * that reached the database.
   */
  skippedByReason: MedicationImportSkipCounts;
  /** Bounded line + reason detail, safe to persist through the job result. */
  skipDetails: MedicationImportSkipDetail[];
  skippedDetailsOmitted: number;
  /**
   * Names the file used that match nothing on the record, deduplicated and in
   * first-seen order. Surfaced verbatim so the person can rename or add the
   * medication and re-run, rather than being told a number.
   */
  unmatchedMedications: string[];
  /** Names that match more than one medication, so no single one can be meant. */
  ambiguousMedications: string[];
  /** Names that match only a medication mirrored from an external list. */
  mirroredMedications: string[];
  /** Data rows read from the file, refusals included. */
  rowsRead: number;
  /** Rows the file marked as belonging to a medication archived in the source. */
  fromArchivedMedications: number;
  /** Rows whose `Codings` cell held something that was left unread. */
  csvCodingsIgnored: number;
  /** Header cells the importer has no verdict for. */
  unknownColumns: string[];
}

function bump(
  counts: MedicationImportSkipCounts,
  reason: MedicationImportSkipReason,
): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

/** Why a row's medication could not be resolved to one on the record. */
type MatchFailure =
  "medication_not_found" | "medication_ambiguous" | "medication_is_mirrored";

/**
 * Resolve every parsed dose against the account's medications and build the
 * queue payload.
 *
 * **A medication is never created from an import file.** The argument for
 * creating them is real: a 3,000-row export names its medications, and refusing
 * every row of an unknown one makes the person do setup work by hand before the
 * import is worth anything. The argument against wins anyway. An import file
 * carries a display name and nothing else — no dose, no unit, no schedule, no
 * form, no delivery route. A medication conjured from it would be a name with a
 * blank dose that every schedule-aware surface then has to tolerate: compliance
 * has no slots to expect, the inventory has no units per dose, reminders have
 * nothing to fire on. And a name that differs by a word from one already on the
 * record would silently fork the history in two, which is worse than a refusal,
 * because a refusal is visible and a fork is not. The unmatched names are
 * reported verbatim instead, so the person adds the medication properly once and
 * re-runs; the import is idempotent, so re-running costs nothing.
 *
 * A name matching two medications is refused rather than resolved to whichever
 * the database returned first.
 */
export function planAutoExportImport(
  parsed: AutoExportParseOutcome,
  medications: readonly MedicationMatchCandidate[],
): AutoExportPlan {
  const skippedByReason: MedicationImportSkipCounts = {};
  let skipDetails: MedicationImportSkipDetail[] = [];
  let skippedDetailsOmitted = 0;
  const recordSkip = (
    line: number,
    reason: MedicationImportSkipReason,
  ): void => {
    bump(skippedByReason, reason);
    const next = appendMedicationImportSkipDetails(
      { skipDetails, skippedDetailsOmitted },
      [{ line, reason }],
    );
    skipDetails = next.skipDetails;
    skippedDetailsOmitted = next.skippedDetailsOmitted;
  };
  for (const refusal of parsed.refusals) {
    recordSkip(refusal.line, refusal.reason);
  }

  const byName = new Map<string, MedicationMatchCandidate[]>();
  for (const medication of medications) {
    const key = normaliseMedicationName(medication.name);
    if (key.length === 0) continue;
    const bucket = byName.get(key);
    if (bucket) bucket.push(medication);
    else byName.set(key, [medication]);
  }

  const named: Record<MatchFailure, string[]> = {
    medication_not_found: [],
    medication_ambiguous: [],
    medication_is_mirrored: [],
  };
  const namedSeen: Record<MatchFailure, Set<string>> = {
    medication_not_found: new Set(),
    medication_ambiguous: new Set(),
    medication_is_mirrored: new Set(),
  };
  const entries: MedicationImportEntry[] = [];
  const seenKeys = new Set<string>();

  const resolve = (
    dose: AutoExportDose,
  ): { ok: true; id: string } | { ok: false; reason: MatchFailure } => {
    // The export can name the same medication twice: `Medication` is the display
    // name and `Nickname` is the person's own label for it. Either may be the one
    // that matches what the record calls it, so both are tried.
    const candidates = [dose.medicationName, dose.nickname]
      .filter((value): value is string => !!value && value.trim().length > 0)
      .map(normaliseMedicationName)
      .filter((value) => value.length > 0);
    for (const key of candidates) {
      const bucket = byName.get(key);
      if (!bucket) continue;
      if (bucket.length > 1) {
        return { ok: false, reason: "medication_ambiguous" };
      }
      // A mirrored medication is a read-only copy of another app's list and only
      // that app's dose events attach to it. Writing an imported dose onto it
      // would put a row the mirror never asserted inside the mirror.
      if (bucket[0].externalSource !== null) {
        return { ok: false, reason: "medication_is_mirrored" };
      }
      return { ok: true, id: bucket[0].id };
    }
    return { ok: false, reason: "medication_not_found" };
  };

  for (const dose of parsed.doses) {
    const match = resolve(dose);
    if (!match.ok) {
      recordSkip(dose.line, match.reason);
      const label = dose.medicationName;
      if (!namedSeen[match.reason].has(label)) {
        namedSeen[match.reason].add(label);
        named[match.reason].push(label);
      }
      continue;
    }

    const idempotencyKey = medicationImportIdempotencyKey(
      match.id,
      dose.scheduledFor,
    );
    // Two rows of one file resolving to the same medication and slot: only one
    // can exist, and saying so here — where the whole file is in hand — counts
    // it exactly, instead of leaving the second row to surface later as though
    // the record had already held that dose.
    if (seenKeys.has(idempotencyKey)) {
      recordSkip(dose.line, "duplicate_in_file");
      continue;
    }
    seenKeys.add(idempotencyKey);

    entries.push({
      medicationId: match.id,
      scheduledFor: dose.scheduledFor.toISOString(),
      takenAt: dose.takenAt === null ? null : dose.takenAt.toISOString(),
      idempotencyKey,
      sourceLine: dose.line,
      ...(dose.doseTaken === null ? {} : { doseTaken: dose.doseTaken }),
    });
  }

  return {
    entries,
    skippedByReason,
    skipDetails,
    skippedDetailsOmitted,
    unmatchedMedications: named.medication_not_found,
    ambiguousMedications: named.medication_ambiguous,
    mirroredMedications: named.medication_is_mirrored,
    rowsRead: parsed.rowsRead,
    fromArchivedMedications: parsed.fromArchivedMedications,
    csvCodingsIgnored: parsed.csvCodingsIgnored,
    unknownColumns: parsed.unknownColumns,
  };
}
