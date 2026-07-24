/**
 * v1.22 (F6) — generalised inline "confirm → apply" Coach action cards.
 *
 * The propose→confirm moat already ships for ONE action type — the cadence
 * reminder (`suggest-reminder.ts` CADENCE_CATALOG → `suggestion` SSE frame →
 * `reminder-suggestion-card.tsx` → `POST /api/coach/reminder-suggestions`).
 * This module generalises it: the Coach may append a `---SUGGEST-ACTION---`
 * block naming ONE action type from a CLOSED allowlist plus bounded,
 * server-resolvable params. The route strips it, validates it, and emits an
 * additive `suggestedAction` SSE frame the client renders as a one-tap confirm
 * card. Confirm POSTs to `POST /api/coach/suggested-actions`, which builds the
 * entity FIELD-BY-FIELD from a server-resolved spec.
 *
 * HARD SAFETY (matches the design §3.6):
 *   - NEVER auto-apply. The frame is additive; the prose stands alone if
 *     ignored. Only the user's confirm tap creates anything.
 *   - CLOSED allowlist only. The model names an action type + bounded params;
 *     it can never mint an arbitrary entity or widen a schedule (the interval
 *     is a closed preset id resolved on the server, never a free rrule).
 *   - NO clinical / medication changes via this path. The allowlist excludes
 *     anything that creates/edits a medication, a dose, or a clinical target.
 *
 * Defence-in-depth mirrors the other sentinels: a byte cap, a single block, the
 * fields validated, a malformed block dropped (the user never sees the marker).
 */

/**
 * The system-prompt clause teaching the model to emit `---SUGGEST-ACTION---`.
 * Appended to the assembled Coach system prompt in the chat route. Provider-
 * neutral; EN + DE only. Names ONLY the closed allowlist — never medication or
 * clinical changes.
 */
export function buildSuggestActionAddendum(locale: string | undefined): string {
  if (locale?.toLowerCase().startsWith("de")) {
    return `WENN eine deiner Empfehlungen mit einem Tipp umsetzbar ist, biete sie als bestätigbare Aktion an — hänge GENAU EINEN Block ans Ende deiner Antwort. NUR diese geschlossene Liste, NIEMALS Medikamente oder klinische Ziele:
---SUGGEST-ACTION---
action: checkup.create        # eine Vorsorge-/Check-up-Erinnerung
label: <kurzer Titel, z. B. Jährliches Blutbild>
interval: <yearly | halfYearly | quarterly | monthly>
---END---
oder
---SUGGEST-ACTION---
action: reminder.note         # eine Erinnerung, auf etwas zurückzukommen
note: <kurz, worum es geht>
when: <optional: ISO-Datum | +Nd / +Nw | NEXT_BP_LOGGED …>
metric: <optional>
---END---
Wende NIEMALS etwas selbst an — die Person bestätigt mit einem Tipp. Schlage höchstens eine Aktion pro Antwort vor und nur, wenn sie klar hilfreich ist.`;
  }
  return `WHEN one of your recommendations is actionable with a reminder, offer it as a confirmable action — append EXACTLY ONE block at the end of your reply. ONLY this closed allowlist, NEVER a medication or clinical target:
---SUGGEST-ACTION---
action: checkup.create        # a preventive-care / check-up reminder
label: <short title, e.g. Annual blood panel>
interval: <yearly | halfYearly | quarterly | monthly>
---END---
or
---SUGGEST-ACTION---
action: reminder.note         # a reminder to revisit something
note: <short, what to bring back>
when: <optional: ISO date | +Nd / +Nw | NEXT_BP_LOGGED …>
metric: <optional>
---END---
NEVER apply anything yourself — the user confirms with a tap. Suggest at most one action per reply, and only when it is clearly helpful.`;
}

const OPEN_SENTINEL = "---SUGGEST-ACTION---";
const CLOSE_SENTINEL = "---END---";
const SENTINEL_BYTE_CAP = 1024;

/** The CLOSED action-type allowlist. NEVER add a clinical / medication type. */
export const SUGGESTED_ACTION_TYPES = [
  "checkup.create",
  "reminder.note",
] as const;
export type SuggestedActionType = (typeof SUGGESTED_ACTION_TYPES)[number];

export function isSuggestedActionType(v: string): v is SuggestedActionType {
  return (SUGGESTED_ACTION_TYPES as readonly string[]).includes(v);
}

/** Field caps shared with the route Zod gate. */
export const CHECKUP_LABEL_MAX_CHARS = 120;
export const ACTION_NOTE_MAX_CHARS = 280;
export const ACTION_METRIC_MAX_CHARS = 60;

/**
 * Closed cadence catalog for `checkup.create`. The model names ONLY a preset
 * id; the server owns the RRULE so the model cannot mint an arbitrary schedule.
 * A preventive-care item is, by nature, infrequent — the set is deliberately
 * coarse (monthly at the tightest).
 */
export const CHECKUP_INTERVAL_CATALOG: Readonly<
  Record<string, { id: string; rrule: string; labelKey: string }>
> = Object.freeze({
  yearly: {
    id: "yearly",
    rrule: "FREQ=YEARLY;INTERVAL=1",
    labelKey: "coach.suggestedAction.interval.yearly",
  },
  halfYearly: {
    id: "halfYearly",
    rrule: "FREQ=MONTHLY;INTERVAL=6",
    labelKey: "coach.suggestedAction.interval.halfYearly",
  },
  quarterly: {
    id: "quarterly",
    rrule: "FREQ=MONTHLY;INTERVAL=3",
    labelKey: "coach.suggestedAction.interval.quarterly",
  },
  monthly: {
    id: "monthly",
    rrule: "FREQ=MONTHLY;INTERVAL=1",
    labelKey: "coach.suggestedAction.interval.monthly",
  },
});
export type CheckupIntervalId = keyof typeof CHECKUP_INTERVAL_CATALOG;

export function isCheckupIntervalId(v: string): v is CheckupIntervalId {
  return Object.prototype.hasOwnProperty.call(CHECKUP_INTERVAL_CATALOG, v);
}

/**
 * The validated params the SSE frame carries + the confirm route accepts. A
 * discriminated union keyed on `actionType`, so the route switch is exhaustive.
 */
export type SuggestedActionParams =
  | { actionType: "checkup.create"; label: string; interval: CheckupIntervalId }
  | {
      actionType: "reminder.note";
      note: string;
      when?: string;
      metric?: string;
    };

/** The DTO the `suggestedAction` SSE frame carries (additive; older clients drop it). */
export interface CoachSuggestedAction {
  actionType: SuggestedActionType;
  /** Plain-text preview of what will be created (the model's own content). */
  summary: string;
  /** i18n key for the action-type heading on the card. */
  titleKey: string;
  params: SuggestedActionParams;
}

const METRIC_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface SuggestActionParseResult {
  prose: string;
  action: CoachSuggestedAction | null;
  malformed: boolean;
}

/** Pull one `key: value` line out of the block body (first match wins). */
function fieldLine(body: string, key: string): string | null {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== key) continue;
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/\s+#.*$/, "")
      .replace(/^["'`]|["'`]$/g, "")
      .trim();
    if (value) return value;
  }
  return null;
}

/** Resolve the per-action params from the block body; null = drop (malformed). */
function resolveActionParams(
  actionType: SuggestedActionType,
  body: string,
): { params: SuggestedActionParams; summary: string; titleKey: string } | null {
  if (actionType === "checkup.create") {
    const labelRaw = fieldLine(body, "label");
    const intervalRaw = fieldLine(body, "interval");
    if (!labelRaw || !intervalRaw) return null;
    const label = labelRaw.slice(0, CHECKUP_LABEL_MAX_CHARS).trim();
    if (!label) return null;
    if (!isCheckupIntervalId(intervalRaw)) return null;
    return {
      params: { actionType, label, interval: intervalRaw },
      summary: label,
      titleKey: "coach.suggestedAction.checkup.title",
    };
  }

  // reminder.note
  const noteRaw = fieldLine(body, "note");
  if (!noteRaw) return null;
  const note = noteRaw.slice(0, ACTION_NOTE_MAX_CHARS).trim();
  if (!note) return null;
  const params: SuggestedActionParams = { actionType: "reminder.note", note };
  const whenRaw = fieldLine(body, "when");
  if (whenRaw) params.when = whenRaw.slice(0, 32);
  const metricRaw = fieldLine(body, "metric");
  if (metricRaw && METRIC_KEY_RE.test(metricRaw)) {
    params.metric = metricRaw.slice(0, ACTION_METRIC_MAX_CHARS).toUpperCase();
  }
  return {
    params,
    summary: note,
    titleKey: "coach.suggestedAction.note.title",
  };
}

/**
 * Strip the `---SUGGEST-ACTION---` block and resolve it into a closed action.
 * Run AFTER the other sentinel strips. An unknown action type, or a missing /
 * invalid param, drops the action (`malformed: true`) while still removing the
 * raw marker from the prose.
 */
/**
 * Strip a TRUNCATED (partial) open sentinel left at the tail of the model's
 * output. A reply cut off mid-marker — e.g. "…worth a look.\n---SUGGEST-ACTIO"
 * — never contains the full `OPEN_SENTINEL`, so the block strip below misses it
 * and the fragment renders raw (the #608 malformed-output class). Remove any
 * trailing run that is a non-empty proper prefix of the open sentinel of at
 * least `---S`, so a legitimate bare "---" separator is left untouched.
 */
function stripTruncatedOpenSentinel(prose: string): string {
  const trimmedEnd = prose.replace(/\s+$/u, "");
  for (let len = OPEN_SENTINEL.length - 1; len >= 4; len--) {
    const partial = OPEN_SENTINEL.slice(0, len);
    if (trimmedEnd.endsWith(partial)) {
      return trimmedEnd.slice(0, trimmedEnd.length - partial.length).trimEnd();
    }
  }
  return prose;
}

export function parseSuggestAction(raw: string): SuggestActionParseResult {
  if (!raw) return { prose: "", action: null, malformed: false };

  const openIdx = raw.indexOf(OPEN_SENTINEL);
  if (openIdx === -1) {
    // No full block — but a truncated open marker at the tail must still be
    // scrubbed so the raw fragment never reaches the user's prose.
    const prose = stripTruncatedOpenSentinel(raw);
    return { prose, action: null, malformed: prose !== raw };
  }

  const before = raw.slice(0, openIdx);
  const afterOpen = raw.slice(openIdx + OPEN_SENTINEL.length);
  const closeRel = afterOpen.indexOf(CLOSE_SENTINEL);
  const bodyRaw = closeRel === -1 ? afterOpen : afterOpen.slice(0, closeRel);
  const body =
    bodyRaw.length > SENTINEL_BYTE_CAP
      ? bodyRaw.slice(0, SENTINEL_BYTE_CAP)
      : bodyRaw;
  const after =
    closeRel === -1 ? "" : afterOpen.slice(closeRel + CLOSE_SENTINEL.length);
  const prose = `${before}${after}`.replace(/^\s+|\s+$/gu, "");

  const actionRaw = fieldLine(body, "action");
  if (!actionRaw || !isSuggestedActionType(actionRaw)) {
    return { prose, action: null, malformed: true };
  }

  const resolved = resolveActionParams(actionRaw, body);
  if (!resolved) return { prose, action: null, malformed: true };

  return {
    prose,
    action: {
      actionType: actionRaw,
      summary: resolved.summary,
      titleKey: resolved.titleKey,
      params: resolved.params,
    },
    malformed: false,
  };
}
