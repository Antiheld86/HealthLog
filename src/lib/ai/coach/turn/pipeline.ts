/**
 * One Coach chat turn, after the route has authenticated, validated,
 * rate-limited and screened the inbound message.
 *
 * Before the stream opens: resolve the conversation and record the user's
 * turn, assemble the context, resolve the chain (consent-gated), re-check the
 * capability at the egress site, and reserve the budget. Any of these can
 * answer on its own (a refusal, a 404, an error frame).
 *
 * Inside the stream: run the model, settle the budget, guard the reply,
 * surface the cards, build the provenance, persist, and only then emit the
 * client-visible frames.
 */
import { createSseStream } from "@/lib/sse/create-stream";

import { settleReservation, reserveTurnBudget } from "./budget";
import { surfaceCards } from "./cards";
import { resolveTurnChain } from "./chain";
import { assembleTurnContext } from "./context";
import { persistUserTurn, resolveTurnConversation } from "./conversation";
import { handleProducerFailure } from "./errors";
import { resolveClarificationAnswer } from "@/lib/ai/coach/clarify";
import { resolveFollowUp } from "@/lib/ai/coach/follow-ups/resolve";
import { readFollowUpHistory } from "@/lib/ai/coach/follow-ups/derive";
import { resolveContinuation } from "@/lib/ai/coach/follow-ups/continue";

import { runTurnModel } from "./model";
import { persistAssistantReply } from "./persist";
import { assembleTurnDialog, buildTurnProvenance } from "./provenance";
import { guardReply } from "./reply-guards";
import { runReuseTurn } from "./reuse-turn";
import {
  SSE_HEADERS,
  createTurnEmitter,
  emitReply,
  startHeartbeat,
} from "./sse";
import type { ReplyOutcome, TurnEmitter, TurnInput } from "./types";

export async function runCoachTurn(input: TurnInput): Promise<Response> {
  const { userId, locale, message } = input;

  // ── Conversation resolution ──────────────────────────────────
  const resolved = await resolveTurnConversation({
    userId,
    conversationId: input.conversationId,
    message,
    locale,
  });
  if ("refusal" in resolved) return resolved.refusal;
  const conversation = resolved.conversation;
  const workingConversationId = conversation.conversationId;

  // v1.39.4 — a tapped chip or an answered question. Resolved against what
  // the server persisted, never against what the client says the chip was.
  // A reuse chip is answered from a stored table without a model call.
  const resolvedFollowUp = await resolveFollowUp({
    userId,
    conversationId: input.conversationId,
    followUp: input.followUp,
    priorResults: conversation.priorResults,
  });
  if (resolvedFollowUp?.followUp.reuse) {
    const reused = await runReuseTurn({
      input,
      conversation,
      resolved: resolvedFollowUp,
    });
    if (reused) return reused;
  }
  const clarifiedLine = await resolveClarificationAnswer({
    userId,
    conversationId: input.conversationId,
    clarification: input.clarification,
  });
  // v1.39.4 — "keep looking": the unfinished question and what the forced
  // turn already read, so the continued turn does not fetch it again.
  const continuation = await resolveContinuation({
    userId,
    conversationId: input.conversationId,
    followUp: input.followUp,
    priorResults: conversation.priorResults ?? [],
  });
  const turnHints = [
    ...(resolvedFollowUp?.contextHint ? [resolvedFollowUp.contextHint] : []),
    ...(continuation ? [continuation.contextHint] : []),
    ...(clarifiedLine ? [clarifiedLine] : []),
  ];

  await persistUserTurn(workingConversationId, message);

  const ctx = await assembleTurnContext({
    userId,
    locale,
    message,
    scope: input.scope,
    guidedQuestion: input.guidedQuestion,
    workoutId: input.workoutId,
    conversation,
  });

  // ── Provider chain ──────────────────────────────────────────
  const chainResult = await resolveTurnChain(userId);
  if (!chainResult.ok) return chainResult.response;
  const { chain, toolMode } = chainResult;

  // The last check before the budget reservation and the provider call: the
  // `coach` capability again, at the egress site, so the call site names its
  // capability whatever happens to the gate at the top. Inside one request
  // the capability inputs are memoised, so this answers from the same
  // resolution as the top gate; a fresh read at the wire belongs to the
  // provider chokepoints, not to this route.
  const refusedAtEgress = await input.recheckCapability();
  if (refusedAtEgress) return refusedAtEgress;

  const budget = await reserveTurnBudget({ userId, chain, toolMode });
  if (!budget.ok) return budget.response;
  const { reservation } = budget;

  // v1.22 (#89) — the provider call + every safety guard + persistence run
  // INSIDE the SSE stream. This is the real fix for a slow local backend: the
  // HTTP response headers flush immediately, a keepalive comment frame goes
  // out every few seconds while the model is still loading / generating so the
  // reverse proxy never idle-drops the connection, and the no-tools (local)
  // path streams real provider tokens with a per-idle-gap timeout instead of
  // one buffered fetch under a total-timeout. Client-visible token frames
  // still carry the FULLY-GUARDED text — every guard runs on the complete
  // reply before the first token frame leaves, exactly as before.
  async function produceReply(emitter: TurnEmitter): Promise<ReplyOutcome> {
    const model = await runTurnModel({
      userId,
      locale,
      signal: input.signal,
      conversationId: workingConversationId,
      ctx,
      chain,
      toolMode,
      reservation,
      emitter,
      turnHints,
      priorResults: conversation.priorResults,
    });
    if (!model.ok) return model;

    await settleReservation(userId, reservation, {
      totalTokens: model.totalTokens,
      cachedTokens: model.cachedTokens,
      servedBy: model.workingProviderType,
    });

    const guarded = await guardReply({
      userId,
      locale,
      conversation,
      ctx,
      toolMode,
      model,
    });
    if (!guarded.ok) return guarded;
    const reply = guarded.reply;

    const cards = await surfaceCards({
      userId,
      coachPrefs: ctx.coachPrefs,
      reply,
    });
    // v1.39.4 — the record's history for the tables' metrics, which the
    // year-ago and wider-window chips need. Read only when a table could
    // carry one.
    const history = reply.outboundBlocked
      ? undefined
      : await readFollowUpHistory({
          userId,
          results: model.results,
          prefs: ctx.coachPrefs,
        });
    const dialog = assembleTurnDialog({
      model,
      reply,
      prefs: ctx.coachPrefs,
      locale,
      history,
      continuationOf: continuation?.sourceMessageId,
    });
    const provenance = buildTurnProvenance({
      snapshotProvenance: ctx.snapshot.provenance,
      reply,
      suggestion: cards.suggestion,
      action: cards.action,
      toolTrace: model.toolTrace,
      steps: model.steps,
      dialog,
      forcedFinal: model.forcedFinal,
      continuationOf: continuation?.sourceMessageId,
    });
    const { messageId } = await persistAssistantReply({
      conversationId: workingConversationId,
      replyText: reply.replyText,
      provenance,
      model,
      ctx,
      toolMode,
      results: dialog.results,
    });

    return {
      ok: true,
      replyText: reply.replyText,
      provenance,
      suggestion: cards.suggestion,
      action: cards.action,
      results: dialog.results,
      followUps: dialog.followUps,
      clarification: dialog.clarification,
      messageId,
      totalTokens: model.totalTokens,
      model: model.result.model ?? null,
    };
  }

  // ── Stream the body to the client ────────────────────────────
  // v1.12.0 — yield to the event loop between token frames so each one flushes
  // as its own network chunk; the visible cadence reads like a live chat reply.
  const stream = createSseStream(async (controller) => {
    const emitter = createTurnEmitter(controller);
    const stopHeartbeat = startHeartbeat(controller);

    let outcome: ReplyOutcome;
    try {
      outcome = await produceReply(emitter);
    } catch (err) {
      stopHeartbeat();
      handleProducerFailure(err, {
        signal: input.signal,
        emitter,
        conversationId: workingConversationId,
      });
      return;
    }
    stopHeartbeat();

    await emitReply(emitter, outcome, workingConversationId);
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
