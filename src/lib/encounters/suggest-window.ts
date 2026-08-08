/**
 * "Gehört das zu einem Termin?" — one rule, one constant, one module.
 *
 * Three moments ask it: a document arriving in the vault, a lab panel being
 * committed from an extraction, and a lab panel typed by hand. They must ask
 * the same question, so none of them owns the answer.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 *   candidates = the caller's own live visits, DONE or PLANNED, whose instant
 *                is within ±{@link ENCOUNTER_SUGGEST_WINDOW_DAYS} days of the
 *                anchor
 *
 *   exactly one  → pre-select it, visibly, with one undo
 *   two or more  → offer a picker with NOTHING pre-selected
 *   zero         → offer nothing at all
 *
 * The middle branch is the whole point. Pre-selecting the first of two is the
 * failure that teaches a person to stop reading suggestions, which costs more
 * than the suggestion ever saved. This module therefore returns the SHAPE of
 * the answer rather than a best guess, and a caller cannot collapse "many" into
 * "one" without writing the collapse itself.
 *
 * ── What it is not ──────────────────────────────────────────────────────────
 *
 * It is not an AI call. The match is a date-window query over the person's own
 * rows: it costs one index scan, cannot hallucinate, and resolves on an account
 * with no provider configured — which matters, because the document assist
 * itself refuses without one.
 *
 * It never blocks. Every caller treats the verdict as an offer; a save works
 * with it ignored, dismissed, or never rendered.
 *
 * ── Why CANCELLED and NO_SHOW are not candidates ────────────────────────────
 *
 * Both name an appointment that did not happen, so neither produced the letter
 * or the panel being filed. Admitting them would widen the candidate set with
 * rows that are wrong most of the time, which pushes the honest single-match
 * case into the picker branch and trains exactly the distrust the two-candidate
 * rule exists to prevent.
 */
import type { Prisma } from "@/generated/prisma/client";

import type { EncounterKind, EncounterStatus } from "@/generated/prisma/client";

/**
 * The half-width of the match window, in days, exported so the three call
 * sites and the tests read the same number. A literal at three call sites is
 * three numbers that agree until one of them is edited.
 */
export const ENCOUNTER_SUGGEST_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A bound on how many candidates are read. Anything above one already means
 * "offer a picker", so the exact count past this cap changes no decision — and
 * an unbounded read on a busy account would load a page of rows to answer a
 * yes/no question.
 */
const MAX_CANDIDATES = 20;

/**
 * One candidate, resolved. Enough to render a row without a second round trip
 * and without the client re-deriving a label the server already holds.
 */
export interface EncounterSuggestion {
  id: string;
  occurredAt: string;
  status: EncounterStatus;
  kind: EncounterKind;
  /** The practice, when the visit names one. `null` is an absence, not a gap. */
  practitionerName: string | null;
}

/**
 * The verdict. A discriminated union rather than an array plus a boolean,
 * because "one" and "many" are different offers and a caller that receives an
 * array will eventually take `[0]`.
 */
export type EncounterSuggestionResult =
  | { kind: "one"; encounter: EncounterSuggestion }
  | { kind: "many"; encounters: EncounterSuggestion[] }
  | { kind: "none" };

/** The statuses a visit can carry and still be the source of a filed record. */
const CANDIDATE_STATUSES: EncounterStatus[] = ["DONE", "PLANNED"];

/**
 * The window around an anchor instant, inclusive on both edges.
 *
 * Exported so a caller that needs the bounds for a different query — the
 * report offer reads the same idea forward-only — states them from here rather
 * than re-deriving the arithmetic.
 */
export function encounterSuggestWindow(anchor: Date): { from: Date; to: Date } {
  const half = ENCOUNTER_SUGGEST_WINDOW_DAYS * DAY_MS;
  return {
    from: new Date(anchor.getTime() - half),
    to: new Date(anchor.getTime() + half),
  };
}

/**
 * Resolve the visit a record dated `anchor` most plausibly belongs to.
 *
 * `userId` is the caller's resolved record id and is fed straight to the
 * `where`; this module never accepts one from a request body.
 */
export async function suggestEncounterForDate(
  tx: Prisma.TransactionClient,
  input: { userId: string; anchor: Date },
): Promise<EncounterSuggestionResult> {
  if (Number.isNaN(input.anchor.getTime())) return { kind: "none" };

  const { from, to } = encounterSuggestWindow(input.anchor);

  const rows = await tx.encounter.findMany({
    where: {
      userId: input.userId,
      deletedAt: null,
      status: { in: CANDIDATE_STATUSES },
      occurredAt: { gte: from, lte: to },
    },
    // Nearest to the anchor would be the kinder order, but Prisma cannot sort
    // by a computed distance; the caller renders a picker in chronological
    // order, which is how a person reads their own week anyway.
    orderBy: { occurredAt: "asc" },
    take: MAX_CANDIDATES,
    select: {
      id: true,
      occurredAt: true,
      status: true,
      kind: true,
      practitioner: { select: { name: true } },
    },
  });

  const encounters: EncounterSuggestion[] = rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    status: row.status,
    kind: row.kind,
    practitionerName: row.practitioner?.name ?? null,
  }));

  if (encounters.length === 0) return { kind: "none" };
  if (encounters.length === 1) return { kind: "one", encounter: encounters[0] };
  return { kind: "many", encounters };
}
