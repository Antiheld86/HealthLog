/**
 * v1.37.0 — the two audit-detail shapes MANAGE is admitted on.
 *
 * The rule the level ships under is "reconstructable or refused": a manager
 * may change and remove things in somebody else's record, and the owner must
 * be able to read out of their own activity feed what went missing. The tree
 * did not carry that. Every edit filed an id and nothing else — `measurement.
 * update` said `{ measurementId }`, `medication.update` said `{ medicationId }`
 * — so the feed could say a reading changed and could not say from what, and
 * the hard deletes filed the id of a row that no longer exists.
 *
 * These two helpers are what the admitted verbs use instead. They are small on
 * purpose: the audit table is not a second copy of the record and must not
 * become one. Three columns, not thirty, and never a decrypted note.
 *
 * Both return a plain object meant to be SPREAD into a `details` literal at
 * the call site rather than to replace it. The literal keeps naming the row's
 * own id in the reviewer's line of sight, which is what the structural guard
 * reads, and the spread carries the part that is tedious to write by hand and
 * easy to get wrong.
 */

/**
 * What may enter an audit row.
 *
 * A closed union rather than `unknown`, because the failure it prevents is the
 * one that costs the most: `details: { previous: existing }` is one keystroke
 * from `details: { previous: { …, notesEncrypted } }`, and an encrypted note
 * copied into the audit table is PHI with a second retention policy and no
 * rotation story. A caller with a value outside this union has to decide what
 * the feed should say about it, which is the decision this type exists to
 * force.
 */
export type AuditScalar = string | number | boolean | Date | null | undefined;

/** The longest string that lands verbatim; anything longer is trimmed. */
const MAX_VALUE_LENGTH = 120;

function coerce(value: AuditScalar): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    return value.length > MAX_VALUE_LENGTH
      ? `${value.slice(0, MAX_VALUE_LENGTH)}…`
      : value;
  }
  return value;
}

function same(a: AuditScalar, b: AuditScalar): boolean {
  const left = a instanceof Date ? a.getTime() : (a ?? null);
  const right = b instanceof Date ? b.getTime() : (b ?? null);
  return left === right;
}

/**
 * **C4** — what an overwrite replaced.
 *
 * `fields` names the family the write touched, so the owner's feed can say
 * "changed the value and the time" rather than "changed a reading".
 * `previous` carries the values that are gone, for the fields where a handful
 * of scalars is the whole fact.
 *
 * @param before the pre-image, caller-picked field by field. Never the row
 *   object: picking is the review step, and a spread of the row is how an
 *   encrypted column gets into an audit table.
 * @param after the post-image over the same keys. Fields whose value did not
 *   move are left out of both halves — an edit that renamed nothing should not
 *   file a line saying it did.
 * @param redacted fields that changed and whose values must never be written:
 *   free text, anything encrypted at rest. They appear in `fields` and never
 *   in `previous`, which is the honest answer — the feed says the note was
 *   rewritten and does not say what it said.
 */
export function overwriteDetails(args: {
  before: Record<string, AuditScalar>;
  after: Record<string, AuditScalar>;
  redacted?: readonly string[];
}): {
  fields: string[];
  previous: Record<string, string | number | boolean | null>;
} {
  const previous: Record<string, string | number | boolean | null> = {};
  const fields: string[] = [];

  for (const key of Object.keys(args.before)) {
    if (same(args.before[key], args.after[key])) continue;
    fields.push(key);
    previous[key] = coerce(args.before[key]);
  }
  for (const key of args.redacted ?? []) {
    if (!fields.includes(key)) fields.push(key);
  }

  return { fields: fields.sort(), previous };
}

/**
 * **C3** — what a hard delete destroyed.
 *
 * For the verbs whose domain does not tombstone, where the row is gone the
 * moment the transaction commits and the audit row is the only thing left. It
 * names the model, the id, a human label and the date the thing was about,
 * which is the difference between "a preventive-care reminder was deleted" and
 * "the colonoscopy recall for next March was deleted".
 *
 * `extra` is for the one or two domain facts a label cannot carry — a
 * severity, a dose, a count. Scalars only, same reasoning as above.
 */
export function destroyedDetails(args: {
  model: string;
  id: string;
  label: AuditScalar;
  effectiveAt: AuditScalar;
  extra?: Record<string, AuditScalar>;
}): Record<string, string | number | boolean | null> {
  const details: Record<string, string | number | boolean | null> = {
    destroyedModel: args.model,
    destroyedId: args.id,
    destroyedLabel: coerce(args.label),
    destroyedAt: coerce(args.effectiveAt),
  };
  for (const [key, value] of Object.entries(args.extra ?? {})) {
    details[key] = coerce(value);
  }
  return details;
}
