/**
 * Clarifying questions. The model may end a reply with a `---CLARIFY---`
 * block when the metric or window stays genuinely ambiguous:
 *
 *   Which pulse do you mean?
 *   ---CLARIFY---
 *   kind: metric
 *   choices: pulse, resting_hr, walking_hr
 *   ---END---
 *
 * The block is always stripped from the prose. What survives is decided here,
 * never by the model:
 *
 * - `metric` choices are kept only when the record holds that metric (an
 *   inventory row marked present). Fewer than two left, and there is nothing
 *   to choose between: the clarification is dropped and the reply stands.
 * - `window` choices come from the window presets only.
 * - `context` carries no choices; the person types the answer.
 * - The question text is the reply itself. It is screened like any reply
 *   (the outbound screen and the refusal detector); a hit drops the choices.
 *
 * Labels are rendered on the server from the catalog, so no model text ever
 * reaches a button. The person answers with
 * `clarification: { messageId, choiceId? }`, which `resolveClarificationAnswer`
 * turns into one server-written line for the next turn's context.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import {
  coachScopeSourceSchema,
  coachScopeWindowSchema,
  type CoachClarification,
  type CoachClarificationChoice,
  type CoachScopeSource,
  type CoachScopeWindow,
} from "@/lib/ai/coach/types";
import { coachClarificationSchema } from "@/lib/ai/coach/stream-events";
import {
  clarifyWindowLabelKey,
  coachDomainLabelKey,
} from "@/lib/ai/coach/dialog-keys";
import { screenCoachReply } from "@/lib/ai/coach/outbound-guard";
import { detectRefusal } from "@/lib/ai/coach/refusal";
import { COACH_SOURCE_DOMAIN_LABEL } from "@/lib/ai/coach/tools/source-keys";
import type { InventoryEntry } from "@/lib/ai/coach/tools/inventory";

const OPEN_SENTINEL = "---CLARIFY---";
const CLOSE_SENTINEL = "---END---";
/** Block body cap in bytes, after the opening marker. */
export const CLARIFY_BYTE_CAP = 512;
/** At most this many choices on a card. */
export const CLARIFY_MAX_CHOICES = 4;
/**
 * A clarifying question is one short sentence. A reply longer than this
 * answered something as well, so it is not a question and gets no card.
 */
const QUESTION_CHAR_CAP = 400;

type ClarifyKind = CoachClarification["kind"];

/** Why a block did not become a card. Ops-facing only. */
export type ClarifyDropReason =
  | "malformed"
  | "byte_overflow"
  | "too_few_metrics"
  | "no_window_choices"
  | "no_question"
  | "question_too_long"
  | "screened"
  | "no_inventory";

/**
 * Dedicated-tool rows of the inventory carry no `metric` argument; these are
 * the scope sources they stand for.
 */
const DEDICATED_TOOL_SOURCE: Readonly<Record<string, CoachScopeSource>> = {
  get_sleep: "sleep",
  get_glucose_panel: "glucose",
  get_medication_compliance: "compliance",
};

const SCOPE_SOURCES: ReadonlySet<string> = new Set(
  coachScopeSourceSchema.options,
);
/** Lower-cased preset → the preset, so "lastyear" still maps to "lastYear". */
const WINDOW_BY_TOKEN: ReadonlyMap<string, CoachScopeWindow> = new Map(
  coachScopeWindowSchema.options.map((w) => [w.toLowerCase(), w]),
);

/** "resting heart rate" → "resting_hr", so either spelling maps. */
const SOURCE_BY_DOMAIN_LABEL: ReadonlyMap<string, CoachScopeSource> = new Map(
  (
    Object.entries(COACH_SOURCE_DOMAIN_LABEL) as Array<
      [CoachScopeSource, string]
    >
  ).map(([source, label]) => [label.toLowerCase(), source]),
);

function normaliseToken(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .toLowerCase();
}

function toSource(token: string): CoachScopeSource | null {
  const t = normaliseToken(token);
  if (SCOPE_SOURCES.has(t)) return t as CoachScopeSource;
  return SOURCE_BY_DOMAIN_LABEL.get(t) ?? null;
}

/** The scope sources the record holds, from the inventory's present rows. */
export function presentSources(
  inventory: readonly InventoryEntry[],
): Set<CoachScopeSource> {
  const out = new Set<CoachScopeSource>();
  for (const entry of inventory) {
    if (!entry.present) continue;
    if (entry.metric && SCOPE_SOURCES.has(entry.metric)) {
      out.add(entry.metric as CoachScopeSource);
      continue;
    }
    const dedicated = DEDICATED_TOOL_SOURCE[entry.tool];
    if (dedicated) out.add(dedicated);
  }
  return out;
}

interface RawBlock {
  kind: string | null;
  choices: string[];
}

/**
 * Cut the block out of the prose. Returns the prose without it and the raw
 * block, or a drop reason when a block was there but unusable. A reply with
 * no marker comes back untouched with `block: null` and no reason.
 */
function extractBlock(prose: string): {
  prose: string;
  block: RawBlock | null;
  dropped: ClarifyDropReason | null;
} {
  const open = prose.indexOf(OPEN_SENTINEL);
  if (open === -1) return { prose, block: null, dropped: null };
  const before = prose.slice(0, open);
  const afterOpen = prose.slice(open + OPEN_SENTINEL.length);
  const close = afterOpen.indexOf(CLOSE_SENTINEL);
  if (close === -1) {
    // No closing marker: everything after the opening one is the block.
    // Never show the raw marker; drop the whole tail.
    return { prose: before.trimEnd(), block: null, dropped: "malformed" };
  }
  const body = afterOpen.slice(0, close);
  const after = afterOpen.slice(close + CLOSE_SENTINEL.length);
  const stripped = `${before.trimEnd()}${after.trim() ? `\n\n${after.trim()}` : ""}`;
  if (Buffer.byteLength(body, "utf8") > CLARIFY_BYTE_CAP) {
    return { prose: stripped, block: null, dropped: "byte_overflow" };
  }
  let kind: string | null = null;
  let choices: string[] = [];
  for (const line of body.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const key = normaliseToken(line.slice(0, colon));
    const value = line.slice(colon + 1);
    if (key === "kind") kind = normaliseToken(value);
    else if (key === "choices") {
      choices = value
        .split(/[,|;]/)
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
    }
  }
  return { prose: stripped, block: { kind, choices }, dropped: null };
}

function isKind(value: string | null): value is ClarifyKind {
  return value === "metric" || value === "window" || value === "context";
}

function metricChoices(
  tokens: readonly string[],
  present: ReadonlySet<CoachScopeSource>,
  locale: Locale,
): CoachClarificationChoice[] {
  const { t } = getServerTranslator(locale);
  const seen = new Set<CoachScopeSource>();
  const choices: CoachClarificationChoice[] = [];
  for (const token of tokens) {
    const source = toSource(token);
    if (!source || seen.has(source) || !present.has(source)) continue;
    seen.add(source);
    const labelKey = coachDomainLabelKey(source);
    choices.push({
      id: `c${choices.length + 1}`,
      labelKey,
      label: t(labelKey),
      value: { metric: source },
    });
    if (choices.length === CLARIFY_MAX_CHOICES) break;
  }
  return choices;
}

function windowChoices(
  tokens: readonly string[],
  locale: Locale,
): CoachClarificationChoice[] {
  const { t } = getServerTranslator(locale);
  const seen = new Set<CoachScopeWindow>();
  const choices: CoachClarificationChoice[] = [];
  for (const token of tokens) {
    const window = WINDOW_BY_TOKEN.get(normaliseToken(token));
    if (!window || seen.has(window)) continue;
    seen.add(window);
    const labelKey = clarifyWindowLabelKey(window);
    choices.push({
      id: `c${choices.length + 1}`,
      labelKey,
      label: t(labelKey),
      value: { window },
    });
    if (choices.length === CLARIFY_MAX_CHOICES) break;
  }
  return choices;
}

function hasQuestionMark(text: string): boolean {
  return /[?？]/.test(text);
}

export function parseClarifySentinel(args: {
  prose: string;
  /** What the record holds; null on the no-tools path. */
  inventory: InventoryEntry[] | null;
  locale: Locale;
}): { prose: string; clarification: CoachClarification | null } {
  const { locale, inventory } = args;
  const extracted = extractBlock(args.prose);
  const prose = extracted.prose;
  const drop = (reason: ClarifyDropReason, kind?: string | null) => {
    annotate({
      action: { name: "coach.clarification.dropped" },
      meta: { reason, kind: isKind(kind ?? null) ? kind : "unknown" },
    });
    return { prose, clarification: null };
  };
  if (extracted.dropped) return drop(extracted.dropped);
  const block = extracted.block;
  if (!block) return { prose, clarification: null };
  if (!isKind(block.kind)) return drop("malformed", block.kind);
  const kind = block.kind;

  const question = prose.trim();
  if (!question || !hasQuestionMark(question)) return drop("no_question", kind);
  if (question.length > QUESTION_CHAR_CAP) {
    return drop("question_too_long", kind);
  }
  // The question is model text shown to the person: screen it like a reply,
  // and like a message (an instruction smuggled into a question is refused).
  if (
    screenCoachReply(question, locale).block ||
    detectRefusal({ message: question, locale }).refuse
  ) {
    return drop("screened", kind);
  }

  let choices: CoachClarificationChoice[] = [];
  if (kind === "metric") {
    // Without an inventory nothing proves the record holds a metric, so
    // there is nothing to offer.
    if (!inventory) return drop("no_inventory", kind);
    choices = metricChoices(block.choices, presentSources(inventory), locale);
    if (choices.length < 2) return drop("too_few_metrics", kind);
  } else if (kind === "window") {
    choices = windowChoices(block.choices, locale);
    if (choices.length < 2) return drop("no_window_choices", kind);
  }

  annotate({
    action: { name: "coach.clarification.offered" },
    meta: { kind, choices: choices.length },
  });
  return {
    prose,
    clarification: { kind, choices, freeText: true },
  };
}

/** The newest few messages of an owned conversation, newest first. */
async function latestMessages(userId: string, conversationId: string) {
  return prisma.coachMessage.findMany({
    where: { conversationId, conversation: { userId } },
    orderBy: { createdAt: "desc" },
    take: 4,
    select: {
      id: true,
      role: true,
      providerType: true,
      metricSourceJson: true,
    },
  });
}

function storedClarification(
  metricSourceJson: string | null,
): CoachClarification | null {
  if (!metricSourceJson) return null;
  try {
    const raw = (JSON.parse(metricSourceJson) as { clarification?: unknown })
      .clarification;
    if (raw === undefined) return null;
    const parsed = coachClarificationSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Never two questions in a row: when the previous assistant reply already
 * asked one, a new block is dropped and the reply stands as an answer. Runs
 * after the person's message is persisted, so the latest assistant row is
 * the previous reply. Reads nothing when there is no clarification to check.
 */
export async function dropRepeatClarification(args: {
  userId: string;
  conversationId: string;
  clarification: CoachClarification | null;
}): Promise<CoachClarification | null> {
  const { clarification } = args;
  if (!clarification) return null;
  try {
    const rows = await latestMessages(args.userId, args.conversationId);
    const previous = rows.find(
      (m) => m.role === "assistant" && m.providerType !== "cancelled",
    );
    if (previous && storedClarification(previous.metricSourceJson)) {
      annotate({
        action: { name: "coach.clarification.dropped" },
        meta: { reason: "repeat", kind: clarification.kind },
      });
      return null;
    }
    return clarification;
  } catch {
    // Unverifiable: offering no card is the safe side.
    return null;
  }
}

function clarifiedLine(choice: CoachClarificationChoice): string {
  const parts: string[] = [];
  if (choice.value.metric) parts.push(`metric=${choice.value.metric}`);
  if (choice.value.window) parts.push(`window=${choice.value.window}`);
  return `CLARIFIED: the person answered your clarifying question by choosing ${parts.join(" ")}. Answer the original question with exactly this; do not ask again.`;
}

const FREE_TEXT_LINE =
  "CLARIFIED: the person answered your clarifying question in their own words (their latest message). Take it as the answer to the original question; do not ask again.";

/**
 * The turn-context line for an answered clarification, or null when the
 * request carries none or its question is no longer current.
 *
 * The question must be the conversation's latest message, asked by the
 * assistant, with its choices on file. The choice value is read from what
 * the server stored, never from the request.
 */
export async function resolveClarificationAnswer(args: {
  userId: string;
  conversationId: string | undefined;
  clarification: { messageId: string; choiceId?: string } | undefined;
}): Promise<string | null> {
  const { userId, conversationId, clarification } = args;
  if (!clarification || !conversationId) return null;
  let rows: Awaited<ReturnType<typeof latestMessages>>;
  try {
    rows = await latestMessages(userId, conversationId);
  } catch {
    return null;
  }
  const latest = rows.find((m) => m.providerType !== "cancelled");
  const stored =
    latest &&
    latest.id === clarification.messageId &&
    latest.role === "assistant"
      ? storedClarification(latest.metricSourceJson)
      : null;
  if (!stored) {
    annotate({
      action: { name: "coach.clarification.stale" },
      meta: { conversationId },
    });
    return null;
  }
  const choice = clarification.choiceId
    ? stored.choices.find((c) => c.id === clarification.choiceId)
    : undefined;
  annotate({
    action: { name: "coach.clarification.answered" },
    meta: { kind: stored.kind, via: choice ? "choice" : "text" },
  });
  return choice ? clarifiedLine(choice) : FREE_TEXT_LINE;
}
