/**
 * Persist a Coach reply and record the turn on the wide event.
 */
import { annotate } from "@/lib/logging/context";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";
import type { CoachProvenance } from "@/lib/ai/coach/types";
import { appendMessage } from "@/lib/ai/coach/persistence";

import type { TurnContext } from "./context";
import type { ModelOutcome } from "./model";

export async function persistAssistantReply(args: {
  conversationId: string;
  replyText: string;
  provenance: CoachProvenance;
  model: Extract<ModelOutcome, { ok: true }>;
  ctx: TurnContext;
  toolMode: boolean;
}): Promise<{ messageId: string }> {
  const { conversationId, replyText, provenance, model, ctx, toolMode } = args;
  const workingProviderType: ProviderChainType = model.workingProviderType;
  const totalTokensSpent = model.totalTokens;

  // Persist the assistant message BEFORE we begin streaming; if the
  // client disconnects we still have the canonical row.
  const assistantMessage = await appendMessage({
    conversationId,
    role: "assistant",
    content: replyText,
    metricSource: provenance,
    providerType: workingProviderType,
    promptVersion: PROMPT_VERSION,
    // v1.18.9 — persist the per-turn token count + model so the quiet
    // token footer survives a conversation reload. The live turn paints
    // from the `done.usage` SSE frame; reloads read these columns.
    // v1.20.0 (F1) — the summed cost across every tool round, so the footer
    // reflects the true turn cost on the tool path too.
    tokensUsed: totalTokensSpent || null,
    model: model.result.model ?? null,
  });

  // v1.18.7 — the day's spend was already reconciled against the
  // reservation immediately after the provider returned, so there is
  // no post-persistence ledger bump here. The reservation guarantees the
  // tokens are counted even if persistence or streaming fails afterwards.

  annotate({
    action: { name: "insights.coach.replied" },
    meta: {
      provider: workingProviderType,
      // v1.20.0 (F1) — summed tokens across every tool round (the loop) or the
      // single call (no-tools path), so the dashboards see the true turn cost.
      tokens: totalTokensSpent,
      promptVersion: PROMPT_VERSION,
      conversationId,
      historyTurns: ctx.turnContext.window.length,
      // v1.20.0 (F1) — whether this turn ran the tool-retrieval path, and how
      // many tools it fetched, so the dashboards can correlate the token delta
      // with the new path vs the legacy snapshot path.
      toolMode,
      toolsCalled: model.toolTrace.length,
      // v1.19.1 (C4) — whether the full SNAPSHOT block rode this turn (the
      // expensive prefix) vs the cheap pointer. On the tool path the snapshot
      // never rides the prompt, so this is the legacy-path signal only.
      snapshotSent: !toolMode && ctx.turnContext.includeFullSnapshot,
      promptChars: ctx.userPrompt.length,
      // v1.7.0 — count of provenance metrics the snapshot surfaced
      // this turn (a proxy for cluster breadth) so the dashboards can
      // correlate reply shape with cluster activation.
      clusterCount: ctx.snapshot.provenance.metrics.length,
    },
  });

  return { messageId: assistantMessage.id };
}
