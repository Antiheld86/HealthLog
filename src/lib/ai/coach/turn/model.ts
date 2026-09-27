/**
 * Run the model for one Coach turn: the tool-retrieval loop when every
 * provider in the chain supports tools, otherwise the streaming no-tools
 * completion over the full snapshot. A provider failure is classified into
 * the structured `coach.*` code the stream answers with.
 */
import { annotate } from "@/lib/logging/context";
import type { Locale } from "@/lib/i18n/config";
import { localeLanguageNames as LANGUAGE_NAMES } from "@/lib/i18n/config";
import {
  AllProvidersFailedError,
  runStreamingRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import { singleUserTurn, type CompletionResult } from "@/lib/ai/types";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { appendMessage } from "@/lib/ai/coach/persistence";
import { buildCoachToolRequest } from "@/lib/ai/coach/chat-request-builder";
import {
  COACH_TOOL_DEFS,
  buildCoachDataInventory,
  renderDataInventory,
  renderFocusHint,
  buildToolModeAddendum,
  runCoachToolLoop,
  type CoachToolTrace,
} from "@/lib/ai/coach/tools";

import { refundReservation, type TurnReservation } from "./budget";
import type { TurnChain } from "./chain";
import type { TurnContext } from "./context";
import { classifyBubblingProviderError } from "./errors";
import type { TurnEmitter } from "./types";

export type ModelOutcome =
  | {
      ok: true;
      result: CompletionResult;
      /**
       * v1.38.19 — typed as the chain's provider union, not a bare string:
       * the budget reconcile attributes the turn's tokens to the cost owner of
       * the hop named here.
       */
      workingProviderType: ProviderChainType;
      toolTrace: CoachToolTrace[];
      /**
       * v1.21.0 (P6) — the present tool-result payloads this turn, for the
       * post-hoc prose number-verifier. Empty on the no-tools path.
       */
      toolResultPayloads: unknown[];
      /**
       * v1.21.2 (A8) — no-tools/local-provider parity for the prose
       * number-verifier. The tool path grades prose against the figures the
       * tools returned; the no-tools path has no tools, so the authoritative
       * set is the SNAPSHOT the model was actually shown this turn —
       * `snapshot.sections`, the structured record `snapshotJson` is
       * serialised from, which already carries the correlations-snapshot
       * block. Populated only when the full figures were delivered this turn
       * (`includeFullSnapshot`); on a cheap follow-up the block was not
       * re-sent, so there is no fresh authoritative set to grade against.
       */
      noToolsSnapshotPayloads: unknown[];
      /**
       * The DATA INVENTORY manifest (per-domain sample counts) that rode this
       * turn's tool-mode prompt. The all-missed activation needs it as a
       * WIDENER: the counts were in front of the model, so a plain count
       * restatement ("you've logged 42 BP readings") must stay grounded even
       * on a turn whose every tool missed. Never an ACTIVATOR on its own —
       * see the v1.32.1 note below.
       */
      inventoryPayloads: unknown[];
      totalTokens: number;
      /**
       * v1.21.0 (F3) — cached-input tokens to subtract at reconcile
       * (prompt-cached input the user did not re-pay for must not be billed
       * to the daily meter).
       */
      cachedTokens: number;
    }
  | { ok: false; code: string };

export async function runTurnModel(args: {
  userId: string;
  locale: Locale;
  signal: AbortSignal;
  conversationId: string;
  ctx: TurnContext;
  chain: TurnChain;
  toolMode: boolean;
  reservation: TurnReservation;
  /**
   * The turn's frame channel. Not written to yet: the model step is where
   * live progress frames will originate.
   */
  emitter: TurnEmitter;
}): Promise<ModelOutcome> {
  const { userId, locale, signal, conversationId, ctx, chain, toolMode } = args;
  const { effectiveScope, workoutEvidence, turnContext, snapshot } = ctx;
  try {
    if (toolMode) {
      // v1.20.0 (F1) — base context: the full system prompt + a tool-mode
      // grounding addendum, with the tiny DATA INVENTORY manifest and the
      // transcript on the user turn. The figures are NOT in the prompt — the
      // model pulls only what it needs via the retrieval tools. The inventory
      // build reuses the snapshot we already computed (60s LRU), so the tools
      // that fire this turn share its reads.
      const inventory = await buildCoachDataInventory(userId, effectiveScope);
      const toolRequest = buildCoachToolRequest({
        systemPrompt: ctx.systemPrompt,
        toolModeAddendum: buildToolModeAddendum(locale),
        focusHint: renderFocusHint(effectiveScope?.sources),
        workoutEvidence,
        dataInventory: renderDataInventory(inventory),
        guidedBlock: turnContext.guidedBlock,
        transcript: turnContext.transcript,
        languageName: LANGUAGE_NAMES[locale],
      });
      const loop = await runCoachToolLoop({
        userId,
        providers: chain,
        system: toolRequest.system,
        messages: toolRequest.messages,
        tools: COACH_TOOL_DEFS,
        temperature: AI_BUDGETS.coach.temperature,
        maxTokens: AI_BUDGETS.coach.maxTokens,
        fallbackWindow: effectiveScope?.window,
        // v1.21.0 (D5-1) — share the inventory's full-source snapshot across
        // every tool so the turn builds ONE snapshot, not one per tool. The
        // probe scope is the exact scope the inventory was built against, so the
        // per-tool reads land its 60s LRU entry.
        sharedScope: inventory.probeScope,
        // v1.20.1 — thread the abort signal so a mid-generation disconnect tears
        // down the per-round provider calls instead of paying the full cost.
        signal,
        // v1.22 (#89) — per-user response timeout for each tool-round call.
        timeoutMs: ctx.aiResponseTimeoutMs,
      });
      // v1.32.1 — the numeric verifier ACTIVATES only when this turn actually
      // delivered figures the model was told to ground against: a pinned
      // workout-evidence block or a present tool result. The DATA INVENTORY
      // manifest (sample counts per domain) is NOT an activator — it rides
      // every tool-mode prompt even on a turn where the model answered
      // without calling a tool, and on that turn the base prompt deliberately
      // carries no pre-computed figures (the model must fetch them), so the
      // verifier must stay dormant and leave the prompt-level grounding rule
      // as the backstop, exactly as on `main`. Activating it off the
      // counts-only inventory would flag a snapshot figure the model cited
      // without a fresh tool call as ungrounded (a real regression caught by
      // the integration suite). When the turn IS active, the inventory counts
      // still WIDEN the authoritative set so a plain count restatement
      // ("you've logged 42 BP readings") stays grounded.
      const presentToolPayloads = [
        ...(workoutEvidence === null ? [] : [workoutEvidence]),
        // A miss carries no `data` but may carry `available` — the bounded
        // out-of-window aggregate rule 3 lets the model cite. Ground it.
        ...(loop.toolResults ?? []).map((r) => r.data ?? r.available),
      ];
      return {
        ok: true,
        result: loop.result,
        // The loop reports the hop it landed on as a bare string; it is
        // assigned from `workingProvider.providerType` one frame up.
        workingProviderType: loop.workingProviderType as ProviderChainType,
        toolTrace: loop.toolTrace,
        toolResultPayloads:
          presentToolPayloads.length > 0
            ? [...presentToolPayloads, inventory.entries]
            : [],
        noToolsSnapshotPayloads: [],
        inventoryPayloads: [inventory.entries],
        totalTokens: loop.totalTokens,
        cachedTokens: loop.cachedTokens,
      };
    }
    // v1.22 (#89) — the no-tools path (local / Ollama / exo, and any chain
    // that includes a non-tool provider) runs through the STREAMING runner so
    // the local client emits real tokens as they arrive and the per-idle-gap
    // timeout governs. `onDelta` counts streamed chunks for observability; the
    // heartbeat keeps the proxy connection warm and the assembled reply is
    // returned in full so every guard still runs on the complete text.
    let streamedDeltas = 0;
    const fallback = await runStreamingRawCompletionWithFallback({
      surface: "coach",
      userId,
      providers: chain,
      onDelta: () => {
        streamedDeltas += 1;
      },
      // v1.20.0 — the no-tools path still builds one assembled user turn (the
      // transcript-flattening includes the current authoritative snapshot
      // on every stateless no-tools request), so it ships as a single user
      // message. The stable persona rides `system` and is cache-eligible.
      params: singleUserTurn({
        system: ctx.systemPrompt,
        user: ctx.userPrompt,
        temperature: AI_BUDGETS.coach.temperature,
        maxTokens: AI_BUDGETS.coach.maxTokens,
        // v1.20.1 — thread the request's abort signal so a mid-generation
        // client disconnect tears the upstream provider call down instead of
        // paying the full token cost into a closed connection.
        signal,
        // v1.22 (#89) — per-idle-gap timeout for the streaming local call /
        // whole-call timeout for the buffered cloud fallback.
        timeoutMs: ctx.aiResponseTimeoutMs,
      }),
    });
    annotate({
      action: { name: "coach.stream.deltas" },
      meta: { deltas: streamedDeltas },
    });
    const result = fallback.result;
    return {
      ok: true,
      result,
      workingProviderType: fallback.workingProvider.providerType,
      toolTrace: [],
      toolResultPayloads: [],
      // v1.21.2 (A8) — the no-tools path grades only when it delivered the
      // full SNAPSHOT. Stateless provider requests always do; retaining the
      // conditional keeps the builder contract explicit and testable.
      noToolsSnapshotPayloads: turnContext.includeFullSnapshot
        ? [
            snapshot.sections,
            ...(workoutEvidence === null ? [] : [workoutEvidence]),
          ]
        : [],
      inventoryPayloads: [],
      totalTokens: result.tokensUsed ?? 0,
      cachedTokens: result.cachedInputTokens ?? 0,
    };
  } catch (err) {
    // The provider chain failed outright — no tokens were billed, so refund
    // the full reservation before surfacing the error frame.
    await refundReservation(userId, args.reservation);
    // #781 — the client walked away mid-generation. The request's abort
    // signal is threaded into every provider call, so the teardown surfaces
    // here as an abort-shaped failure with `request.signal` already flipped.
    // Close the turn honestly instead of letting the user message dangle
    // unanswered: persist an EMPTY assistant marker tagged
    // `providerType: "cancelled"` (the same channel "refusal" and "nudge"
    // already use for non-provider rows) so the thread shows the turn as
    // interrupted and offers a retry on reload. The content is empty by
    // construction — nothing guarded was produced, and anything the client
    // ever SAW was persisted before the first token frame left, so no
    // unguarded partial text is ever written. The reservation was refunded
    // above; a retry pays exactly what a fresh turn pays.
    if (signal.aborted) {
      await appendMessage({
        conversationId,
        role: "assistant",
        content: "",
        providerType: "cancelled",
        promptVersion: PROMPT_VERSION,
      }).catch(() => {
        // Marker persistence is best-effort — a failure leaves the
        // dangling user turn, which is exactly the pre-#781 state.
      });
      annotate({
        action: { name: "insights.coach.cancelled" },
        meta: { conversationId },
      });
      return { ok: false, code: "coach.cancelled" };
    }
    if (err instanceof AllProvidersFailedError) {
      annotate({
        action: { name: "insights.coach.providerFailed" },
        meta: {
          attempts: err.attempts.length,
          firstStatus: err.attempts[0]?.httpStatus ?? null,
          credentialExpired: err.primaryCredentialExpired,
        },
      });
      // v1.11.0 W1 — when the user's PRIMARY provider failed with an
      // auth-class status (401/403), the credential is dead, not the
      // service. Surface a distinct `credential_expired` frame so the
      // drawer can deep-link the user to reconnect rather than telling
      // them to "try again later" — the gap that let an expired codex
      // token silently kill all generation.
      if (err.primaryCredentialExpired) {
        return { ok: false, code: "coach.provider.credential_expired" };
      }
      // v1.4.25 W5 — distinguish provider rate-limit (every attempt
      // landed on 429) from generic unavailability. The drawer's
      // error-decoder surfaces the rate-limit copy with a warning
      // toast instead of the generic provider-down message, so the
      // user understands the limit is transient.
      const allRateLimited =
        err.attempts.length > 0 &&
        err.attempts.every((a) => a.httpStatus === 429);
      return {
        ok: false,
        code: allRateLimited
          ? "coach.provider.rate_limited"
          : "coach.provider.unavailable",
      };
    }
    // v1.21.3 — defence in depth. The chain runner wraps every hard provider
    // failure in `AllProvidersFailedError`, but a provider client can still
    // throw a tagged wire error that reaches here un-wrapped (e.g. a Codex 400
    // raised mid tool-loop on a path the chain runner did not catch). Such an
    // error is a PROVIDER failure, not a server bug — surface the same graceful
    // `coach.provider.*` frame the chain path uses rather than rethrowing into
    // an HTTP 500 (the bug that took the live Coach down for codex users). Only
    // a genuinely unexpected error (no upstream tag, no httpStatus) keeps the
    // 500 + GlitchTip path so real defects stay visible.
    const providerError = classifyBubblingProviderError(err);
    if (providerError) {
      annotate({
        action: { name: "insights.coach.providerFailed" },
        meta: {
          attempts: 1,
          firstStatus: providerError.httpStatus,
          credentialExpired: providerError.code === "credential_expired",
          unwrapped: true,
        },
      });
      return { ok: false, code: `coach.provider.${providerError.code}` };
    }
    throw err;
  }
}
