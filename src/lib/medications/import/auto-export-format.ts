/**
 * The medication dose-history export format, read directly.
 *
 * A self-hoster was hand-mapping this export into the intake importer's
 * two-field shape and guessing at what belonged where. Hand-mapping is what
 * destroyed the part that matters: the export keeps the scheduled time and the
 * time actually taken as two separate columns, which is exactly the pair
 * `MedicationIntakeEvent` models as `scheduledFor` + `takenAt`. Flattening the
 * file collapses them into one.
 *
 * Two shapes exist. The CSV carries ten columns; the JSON carries the
 * documented per-dose object. Both are read here, and every column gets a
 * verdict that the importing person can read before choosing a file — a column
 * dropped in silence is the failure this format work exists to remove.
 *
 * Nothing in this module touches a database. It is the vocabulary and the
 * verdicts; `auto-export-parse.ts` applies them.
 */

/** The CSV header, in the order the export writes it. */
export const AUTO_EXPORT_CSV_COLUMNS = [
  "Date",
  "Scheduled Date",
  "Medication",
  "Nickname",
  "Dosage",
  "Scheduled Dosage",
  "Unit",
  "Status",
  "Archived",
  "Codings",
] as const;

/**
 * What the importer does with a column.
 *
 * `honoured` — the value reaches the record, or decides whether a row does.
 * `reported` — read, never stored; it appears in the run summary so the
 *              person can see what the file said.
 * `ignored`  — deliberately not read, with a stated reason.
 */
export type AutoExportColumnVerdict = "honoured" | "reported" | "ignored";

export interface AutoExportColumnRuling {
  column: string;
  verdict: AutoExportColumnVerdict;
  /**
   * Stable key for the sentence explaining the ruling. The UI resolves it with
   * a literal `t()` call per key so the i18n call-site guard sees every one.
   */
  noteKey: string;
  /** True for a field only the JSON shape carries. */
  jsonOnly?: boolean;
}

/**
 * Every field of both shapes with its ruling. Exhaustive by construction: a
 * structural test asserts each CSV column and each documented JSON field
 * appears exactly once, so a column cannot be added to the parser without a
 * verdict landing here.
 */
export const AUTO_EXPORT_COLUMN_RULINGS: readonly AutoExportColumnRuling[] = [
  { column: "Date", verdict: "honoured", noteKey: "date" },
  { column: "Scheduled Date", verdict: "honoured", noteKey: "scheduledDate" },
  { column: "Medication", verdict: "honoured", noteKey: "medication" },
  { column: "Nickname", verdict: "honoured", noteKey: "nickname" },
  { column: "Dosage", verdict: "honoured", noteKey: "dosage" },
  {
    column: "Scheduled Dosage",
    verdict: "honoured",
    noteKey: "scheduledDosage",
  },
  { column: "Unit", verdict: "honoured", noteKey: "unit" },
  { column: "Status", verdict: "honoured", noteKey: "status" },
  { column: "Archived", verdict: "reported", noteKey: "archived" },
  { column: "Codings", verdict: "ignored", noteKey: "codings" },
  { column: "form", verdict: "ignored", noteKey: "form", jsonOnly: true },
  { column: "start", verdict: "ignored", noteKey: "start", jsonOnly: true },
  { column: "end", verdict: "ignored", noteKey: "end", jsonOnly: true },
] as const;

/**
 * Documented JSON field names. `displayText` is the JSON spelling of the CSV's
 * `Medication`, `isArchived` of `Archived`, `scheduledDate` of `Scheduled
 * Date`; the CSV's `Scheduled Dosage` has no JSON counterpart at all.
 */
export const AUTO_EXPORT_JSON_FIELDS = [
  "displayText",
  "nickname",
  "form",
  "start",
  "end",
  "scheduledDate",
  "status",
  "isArchived",
  "dosage",
  "codings",
] as const;

/**
 * What each documented status is, and therefore what the importer does with it.
 *
 * Seven values, and they are not seven shades of one thing — they divide into
 * four kinds, so they get four rulings rather than one blanket rule.
 *
 * `dose_taken` / `dose_skipped` — the two that state a decision the person made
 * about a dose. Both map one-to-one onto something HealthLog already records: a
 * row with a `takenAt`, and a row with `skipped = true`. That second mapping was
 * checked rather than assumed — `skipped` is documented as a deliberate user
 * skip, held apart from `autoMissed`, which is the marker for a dose nobody ever
 * acted on. So a deliberate skip in the export lands as a deliberate skip here,
 * and not as a miss.
 *
 * `no_dose_information` — `Not Interacted`, `Not Logged`, `Unspecified`. These
 * are absences, not statements. Nobody answered, or nothing was written down.
 * Writing them as taken would invent a dose; writing them as skipped would
 * invent a decision, because "did not answer the notification" is not "chose not
 * to take it"; writing them as still-pending would put outstanding doses from
 * years ago back in front of the person today. So they are counted, reported,
 * and not written. Absence reads as absence.
 *
 * `reminder_event` — `Snoozed` describes what happened to a reminder. A snoozed
 * reminder says nothing at all about whether the medication was taken.
 *
 * `app_event` — `Notification Not Sent` is a fact about the software, not about
 * the person. It belongs to no dose.
 *
 * The three non-dose kinds are all refused, but each under its own name, because
 * "the file says nothing about this dose" and "this row is about a reminder" are
 * different things and a person reading the result acts on them differently.
 */
export const AUTO_EXPORT_STATUS_DISPOSITIONS = {
  Taken: "dose_taken",
  Skipped: "dose_skipped",
  "Not Interacted": "no_dose_information",
  "Not Logged": "no_dose_information",
  Unspecified: "no_dose_information",
  Snoozed: "reminder_event",
  "Notification Not Sent": "app_event",
} as const satisfies Record<string, AutoExportStatusDisposition>;

export type AutoExportStatusDisposition =
  | "dose_taken"
  | "dose_skipped"
  | "no_dose_information"
  | "reminder_event"
  | "app_event";

/** Every status the format documents, in the order the documentation lists it. */
export const AUTO_EXPORT_STATUSES = [
  "Not Interacted",
  "Notification Not Sent",
  "Snoozed",
  "Taken",
  "Skipped",
  "Not Logged",
  "Unspecified",
] as const;

export type AutoExportStatus = (typeof AUTO_EXPORT_STATUSES)[number];

export function isAutoExportStatus(value: string): value is AutoExportStatus {
  return (AUTO_EXPORT_STATUSES as readonly string[]).includes(value);
}

/** The ruling for a documented status. */
export function autoExportStatusDisposition(
  status: AutoExportStatus,
): AutoExportStatusDisposition {
  return AUTO_EXPORT_STATUS_DISPOSITIONS[status];
}

/**
 * Where the export's codings WOULD land, and why they do not land there today.
 *
 * The format documents `codings` as `[{ code, system, version }]` with systems
 * such as RxNorm and NDC. HealthLog already holds two of those: `atcCode`
 * (WHO ATC) and `rxNormCode` (RxCUI) on `Medication`. A code is a far stronger
 * identity than a display name someone may have typed differently in each app,
 * so it is the natural way to match a row to a medication.
 *
 * It is not read, for two reasons that are about evidence rather than effort.
 * The CSV shape — the only shape that carries a dose history at all — gives the
 * `Codings` column no documented encoding, and the sample export leaves it empty
 * on every row, so there is nothing to derive a reader from and no way to test
 * one. The JSON shape does document the structure but carries no intake time, so
 * it is refused whole. A populated `Codings` cell is therefore counted and
 * reported rather than guessed at.
 *
 * If a shape turns up that carries both, these are the columns waiting for it —
 * for matching only. `atcCode` and `rxNormCode` are asserted by the person or
 * their clinician, and an import file is neither.
 */

/**
 * Fold a dose amount and its unit into the free-text per-dose override.
 *
 * `count` is the export's word for "this many of the configured dose" and
 * carries nothing about substance amount, so the number stands alone. Any other
 * unit is echoed exactly as the file wrote it — `0.4 mL`, not a translated or
 * re-cased guess at which of HealthLog's own unit keys was meant.
 */
export function formatAutoExportDose(amount: number, unit: string): string {
  const trimmed = unit.trim();
  // `String` already drops a trailing `.0`, which is how the export writes
  // whole amounts: `1.0` becomes `1`, `0.25` stays `0.25`.
  const rendered = String(amount);
  if (trimmed.length === 0 || trimmed.toLowerCase() === "count") {
    return rendered;
  }
  return `${rendered} ${trimmed}`;
}

/** Normalise a medication name for matching: trimmed, folded, case-blind. */
export function normaliseMedicationName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}
