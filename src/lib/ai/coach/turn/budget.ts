/**
 * The day's token budget for one Coach turn: reserve before the provider
 * call, settle against the actual count after it, refund on failure.
 */
import { annotate } from "@/lib/logging/context";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import {
  buildDateKey,
  reserveBudget,
  reconcileSpend,
  resolveCostOwner,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { MAX_ROUNDS } from "@/lib/ai/coach/tools";

import type { TurnChain } from "./chain";
import { streamProviderError } from "./sse";

export interface TurnReservation {
  reserved: number;
  owner: Awaited<ReturnType<typeof reserveBudget>>["owner"];
  dateKey: string;
}

export async function reserveTurnBudget(args: {
  userId: string;
  chain: TurnChain;
  toolMode: boolean;
}): Promise<
  { ok: true; reservation: TurnReservation } | { ok: false; response: Response }
> {
  const { userId, chain, toolMode } = args;
  // v1.18.7 (SENIOR-DEV HIGH) — atomically RESERVE the day's budget before
  // the provider call. The reservation increments the day's total by the
  // per-call ceiling (`maxTokens`) in one upsert and returns the new total;
  // concurrent requests serialise on the row so they cannot all pass the cap.
  // Over-cap → 429 refusal frame, reservation already refunded. The actual
  // token count is reconciled against this reservation after the call,
  // including on empty / sentinel replies (their tokens were still burned).
  //
  // v1.20.0 (F1) — the tool loop makes up to MAX_ROUNDS provider round-trips,
  // so reserve the per-call ceiling × the round count up front and reconcile
  // the SUMMED actual tokens afterwards. The atomic reserve/reconcile
  // primitives are unchanged; only the reserved amount scales.
  // v1.21.0 (F1) — the daily ceiling is the OPERATOR's cost cap only when the
  // chain egresses via the operator's own key (`admin-openai` primary). A
  // ChatGPT-OAuth/Codex or BYOK chain runs on the user's OWN plan/key and costs
  // the operator nothing, so it gets the generous user-plan ceiling — gating it
  // on the operator-cost cap would lock the user out of a plan they pay for.
  const dailyCap = resolveDailyCap(chain);
  const reqDateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    toolMode
      ? AI_BUDGETS.coach.maxTokens * MAX_ROUNDS
      : AI_BUDGETS.coach.maxTokens,
    reqDateKey,
    dailyCap,
    resolveCostOwner(chain),
    "coach",
  );
  if (!reservation.allowed) {
    // v1.38.19 — say WHICH ceiling refused and WHOSE.
    // `totalAfter` alone is the day's mixed total; on an operator refusal that
    // is not the counter that tripped, and reading `totalAfter: 1200000`
    // against a 200 000 ceiling is what turned the 06:42Z incident into a
    // production log dig. Integers and two small enums — no key, host or model
    // name is added.
    annotate({
      action: { name: "coach.budget.exceeded" },
      meta: {
        owner: reservation.owner,
        surface: "coach",
        limit: reservation.limit,
        cap: dailyCap,
        totalAfter: reservation.totalAfter,
        operatorAfter: reservation.operatorAfter,
      },
    });
    return {
      ok: false,
      response: streamProviderError({ code: "coach.budget.exceeded" }),
    };
  }
  return {
    ok: true,
    reservation: {
      reserved: reservation.reserved,
      owner: reservation.owner,
      dateKey: reqDateKey,
    },
  };
}

/**
 * The provider chain failed outright — no tokens were billed, so refund the
 * full reservation before surfacing the error frame.
 */
export async function refundReservation(
  userId: string,
  reservation: TurnReservation,
): Promise<void> {
  await reconcileSpend(
    userId,
    reservation.reserved,
    0,
    reservation.dateKey,
    0,
    {
      servedBy: null,
      reservedOwner: reservation.owner,
    },
  ).catch(() => {});
}

/**
 * v1.18.7 (SENIOR-DEV MEDIUM) — the provider call returned, so its tokens
 * were billed regardless of reply quality. Reconcile the reservation against
 * the actual count NOW, before any empty/sentinel short-circuit, so an empty
 * or sentinel-only reply still records its burned cost (the old post-hoc
 * `recordSpend` ran only on the happy path, undercounting these).
 * v1.20.0 (F1) — reconcile against the SUMMED tokens across every tool round
 * (the loop accumulates them); the no-tools path sums to the single call.
 */
export async function settleReservation(
  userId: string,
  reservation: TurnReservation,
  spent: {
    totalTokens: number;
    cachedTokens: number;
    servedBy: ProviderChainType;
  },
): Promise<void> {
  await reconcileSpend(
    userId,
    reservation.reserved,
    spent.totalTokens,
    reservation.dateKey,
    spent.cachedTokens,
    { servedBy: spent.servedBy, reservedOwner: reservation.owner },
  ).catch(() => {
    // Ledger reconcile is best-effort; a failure leaves the conservative
    // reservation in place (never an undercount) and never breaks the turn.
  });
}
