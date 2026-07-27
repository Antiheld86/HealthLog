/**
 * The one derivation from a submitted intake-import row to the queued entry.
 *
 * It lives here rather than inline in the route so the test that proves a
 * reported export lands 28 rows can drive the real derivation instead of
 * restating it. A test that mirrors the production formula proves the mirror.
 */

/** A validated row of the import body: a local date and a local wall time. */
export interface MedicationImportRow {
  datum: string;
  uhrzeit: string;
}

export interface MedicationImportQueueEntry {
  scheduledFor: string;
  takenAt: string;
  idempotencyKey: string;
}

/**
 * The replay key for one imported dose: its medication and its slot instant,
 * and nothing else.
 *
 * That is the grain the database already enforces through the live-row unique
 * on `(user_id, medication_id, scheduled_for, source)`, so the key is a
 * function of exactly the same facts. Both import surfaces call it — the
 * hand-listed per-medication body and the export reader — because a key
 * written out twice is a key that can disagree with itself, and two callers
 * that disagree stop deduplicating each other's replays.
 *
 * The key used to be built from the row's optional `zaehler` field whenever it
 * was present. That reads as a per-row counter, but nothing required it to be
 * one and nothing checked. The file that surfaced this repeated `1.0` down the
 * column because it was modelled on the example the import dialog itself
 * displayed — so the value came from us, and a field we presented as a quantity
 * silently decided identity. A month of distinct doses collapsed onto one key.
 *
 * Deriving from the instant makes the key a function of the fact it identifies,
 * and matches the live-row unique on `(user_id, medication_id, scheduled_for,
 * source)` that the database enforces regardless.
 */
export function medicationImportIdempotencyKey(
  medicationId: string,
  scheduledFor: Date,
): string {
  return `import-${medicationId}-${scheduledFor.getTime()}`;
}

/**
 * Derive the queued entries for a hand-listed import body.
 *
 * It lives here rather than inline in the route so the test that proves a
 * reported export lands its rows can drive the real derivation instead of
 * restating it. A test that mirrors the production formula proves the mirror.
 */
export function buildMedicationImportEntries(
  medicationId: string,
  rows: readonly MedicationImportRow[],
): MedicationImportQueueEntry[] {
  return rows.map((row) => {
    const takenAt = new Date(`${row.datum}T${row.uhrzeit}`);
    return {
      // This body carries one time per row and nothing to say which slot it
      // belonged to, so every dose it describes is ad-hoc: anchored on itself,
      // which is how HealthLog already records a dose that belongs to no slot.
      // The export-reading route is the one that has both facts to give.
      scheduledFor: takenAt.toISOString(),
      takenAt: takenAt.toISOString(),
      idempotencyKey: medicationImportIdempotencyKey(medicationId, takenAt),
    };
  });
}
