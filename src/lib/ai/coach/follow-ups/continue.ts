/**
 * "Keep looking": when the loop forced an answer at its round cap, offer a
 * chip that continues the question with what was already fetched.
 *
 * The chip leads the reply's chips. Tapping it runs a normal model turn
 * (budget, capability and rate limit as ever) with two server-written
 * context lines: a pointer to the question that was left unfinished (the
 * question itself stays in the transcript), and what the forced turn already
 * read, each table by the name `show_result` takes, so the
 * continued turn shows those again instead of fetching them a second time.
 *
 * An answer is continued at most once. The continued reply records the
 * message it continues (`metricSource.continuationOf`) and offers no further
 * "keep looking" chip, even if it is forced again; a tapped chip on a reply
 * that is itself a continuation is refused.
 */
import {
  readLatestMessages,
  type LatestMessage,
  type LatestMessagesLoader,
} from "@/lib/ai/coach/latest-messages";
import { annotate } from "@/lib/logging/context";
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { CoachFollowUp, CoachStep } from "@/lib/ai/coach/types";
import {
  coachFollowUpSchema,
  coachStepSchema,
} from "@/lib/ai/coach/stream-events";
import { COACH_FOLLOW_UP_KEYS } from "@/lib/ai/coach/dialog-keys";
import {
  formatPriorResultRef,
  type PriorResultTurn,
} from "@/lib/ai/coach/results/refs";

/**
 * The "keep looking" chip for a reply, or null: only when the loop forced
 * the answer, and never on a reply that already continues another.
 */
export function buildContinueFollowUp(args: {
  forcedFinal: boolean;
  /** Set when this reply continues an earlier forced answer. */
  continuationOf?: string;
  locale: Locale;
}): CoachFollowUp | null {
  if (!args.forcedFinal || args.continuationOf) return null;
  const { t } = getServerTranslator(args.locale);
  const labelKey = COACH_FOLLOW_UP_KEYS.continue;
  return {
    id: "f1",
    kind: "continue",
    labelKey,
    label: t(labelKey),
    reuse: false,
    origin: "server",
  };
}

/** A tapped "keep looking" chip that resolved. */
export interface ResolvedContinuation {
  /** The forced reply being continued; persisted as `continuationOf`. */
  sourceMessageId: string;
  /** The context lines for the continued turn. */
  contextHint: string;
}

interface StoredForced {
  followUps: CoachFollowUp[];
  steps: CoachStep[];
  continuationOf: string | null;
}

function storedDialog(metricSourceJson: string | null): StoredForced | null {
  if (!metricSourceJson) return null;
  try {
    const raw = JSON.parse(metricSourceJson) as Record<string, unknown>;
    const followUps = Array.isArray(raw.followUps)
      ? raw.followUps.flatMap((item) => {
          const parsed = coachFollowUpSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    const steps = Array.isArray(raw.steps)
      ? raw.steps.flatMap((item) => {
          const parsed = coachStepSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    return {
      followUps,
      steps,
      continuationOf:
        typeof raw.continuationOf === "string" ? raw.continuationOf : null,
    };
  } catch {
    return null;
  }
}

/**
 * What a step read, in the tool's own terms: `get_metric_table(bp,
 * last90days, week) → m3.r1`. Only enum fields and server names, so no
 * record text reaches the line.
 */
function fetchedLine(
  step: CoachStep,
  sourceMessageId: string,
  priorResults: readonly PriorResultTurn[],
): string | null {
  if (step.tool === "snapshot" || !step.domain) return null;
  if (step.status !== "done" && step.status !== "empty") return null;
  const args = [
    step.domain,
    ...(step.window ? [step.window] : []),
    ...(step.granularity ? [step.granularity] : []),
    ...(step.period && step.period !== "current" ? [step.period] : []),
  ].join(", ");
  const call = `${step.tool}(${args})`;
  if (step.status === "empty") return `${call} → no readings`;
  const turn = priorResults.find((p) => p.messageId === sourceMessageId);
  const name =
    step.resultRef && turn?.results.some((r) => r.ref === step.resultRef)
      ? formatPriorResultRef(turn.turnIndex, step.resultRef)
      : null;
  return name ? `${call} → ${name}` : call;
}

/**
 * The context lines of a continued turn. Exported for the tests.
 *
 * Server-written only: tool names, enum arguments and table names. The
 * question itself is never lifted in here. It is the person's text and rides
 * the transcript as a user turn; copied into the system role it would carry
 * whatever it says with the system's authority.
 */
export function continuationHint(args: { fetched: string[] }): string {
  const fetched =
    args.fetched.length > 0
      ? ` Already fetched: ${args.fetched.join("; ")}. Use show_result for these tables, do not fetch them again.`
      : "";
  return `CONTINUE: the person asked you to keep looking. The unfinished question is their message before that request, in CONVERSATION.${fetched} Fetch only what is still missing, then answer that question in full.`;
}

/**
 * Resolve a tapped "keep looking" chip, or null when the request carries
 * none. The chip must sit on the conversation's latest reply, stored by the
 * server; a reply that is itself a continuation is refused.
 */
export async function resolveContinuation(args: {
  userId: string;
  conversationId: string | undefined;
  followUp: { messageId: string; id: string } | undefined;
  /** The tables earlier replies hold, named as the turn's context names them. */
  priorResults: readonly PriorResultTurn[];
  /** The turn's shared read of the latest messages, when it has one. */
  latest?: LatestMessagesLoader;
}): Promise<ResolvedContinuation | null> {
  const { userId, conversationId, followUp } = args;
  if (!followUp || !conversationId) return null;
  let rows: LatestMessage[];
  try {
    rows = await (args.latest?.() ??
      readLatestMessages(userId, conversationId));
  } catch {
    return null;
  }
  const live = rows.filter((m) => m.providerType !== "cancelled");
  const latest = live[0];
  if (
    !latest ||
    latest.role !== "assistant" ||
    latest.id !== followUp.messageId
  ) {
    return null;
  }
  const stored = storedDialog(latest.metricSourceJson);
  const chip = stored?.followUps.find(
    (candidate) => candidate.id === followUp.id,
  );
  if (!stored || chip?.kind !== "continue") return null;
  if (stored.continuationOf) {
    annotate({
      action: { name: "coach.followUp.continue_refused" },
      meta: { reason: "already_continued" },
    });
    return null;
  }

  // The question is the person's message the forced reply answered; it
  // must still be there for the continued turn to read.
  if (!live.slice(1).some((m) => m.role === "user")) return null;

  const fetched = stored.steps
    .map((step) => fetchedLine(step, latest.id, args.priorResults))
    .filter((line): line is string => line !== null);
  annotate({
    action: { name: "coach.followUp.continued" },
    meta: { fetched: fetched.length },
  });
  return {
    sourceMessageId: latest.id,
    contextHint: continuationHint({ fetched }),
  };
}
