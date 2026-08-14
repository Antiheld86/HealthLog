/**
 * Per-user, per-day token budget for the AI Coach.
 *
 * Why a separate ledger and not a generic counter on `User`:
 *   - The dispatcher must read the day's spend on every request — a
 *     scalar column would balloon write contention as concurrent
 *     requests race.
 *   - A `(userId, dateKey)` row partitions the writes by day and lets
 *     us add per-day analytics ("avg replies per active user") later
 *     without further migrations.
 *
 * `dateKey` is a UTC `YYYY-MM-DD` string. UTC, not Europe/Berlin: the
 * job runner that may seed off-hour tasks (planned v1.5) needs a
 * boundary that does not jump on DST. Display layers can format with
 * the user's timezone.
 */
import { prisma } from "@/lib/db";
import type { ProviderChainType } from "@/lib/ai/provider-chain";

/**
 * Operator-cost daily ceiling — the cap that protects the OPERATOR's LLM bill.
 *
 * It applies ONLY to the operator-managed-key path (`admin-openai`): the
 * server's own OpenAI key, where every token the user spends lands on the
 * operator's invoice.
 *
 * v1.21.0 (F1/F2) — raised from the historical 25_000. That figure was sized
 * for a single non-reasoning ~600-token chat reply (~20 turns/day). With the
 * v1.20 tool loop charging the Responses-API gross `total_tokens` of a `gpt-5.x`
 * reasoning turn (re-sent system prompt + inventory + 7 tool defs per round +
 * hidden reasoning, summed across rounds ≈ 20k–40k), 25k locked the user out
 * after one turn. 200k keeps gross accounting (no per-round output-token
 * surgery) while leaving room for a normal day of reasoning turns on the
 * operator's key. The cap stays a real ceiling on the operator's exposure.
 */
export const OPERATOR_COST_CAP = 200_000;

/**
 * v1.21.0 (F1) — the daily ceiling for a chain whose egress runs on the
 * USER's own plan / key (ChatGPT-OAuth/Codex, BYOK OpenAI/Anthropic, or a
 * self-hosted local model). The operator pays nothing for these, so the
 * operator-cost cap is a category error here — gating them on it locks a user
 * out of a plan they pay for. We keep only a generous abuse ceiling so a
 * runaway client loop can't write unbounded rows; a normal user never reaches
 * it.
 */
export const USER_PLAN_CAP = 2_000_000;

/**
 * v1.21.0 (F1) — classify a resolved provider chain's cost owner and return
 * the daily cap that applies.
 *
 * The chain is a fallback list; the FIRST entry is the provider that will be
 * tried first and is the expected cost owner. The operator pays when that
 * primary provider is `admin-openai` (the operator's shared API key) OR
 * `admin-codex` (the operator's shared ChatGPT-subscription account) — both
 * drain the operator's resources, so the operator-cost cap applies. Every other
 * primary (`codex` / `openai` / `anthropic` / `local` / `openai-compatible`)
 * is the user's own
 * egress, so the generous user-plan cap applies. An empty chain (no provider
 * resolved) defaults to the operator cap — the conservative side.
 */
export function resolveDailyCap(
  chain: ReadonlyArray<{ providerType: ProviderChainType }>,
): number {
  const primary = chain[0]?.providerType;
  return primary === undefined || isOperatorFundedProvider(primary)
    ? OPERATOR_COST_CAP
    : USER_PLAN_CAP;
}

/**
 * v1.37.19 (A7-2) — does this provider spend the OPERATOR's money?
 * `admin-openai` (the server's own API key) and `admin-codex` (the
 * server's shared ChatGPT account) do; everything else is the user's own
 * egress. One predicate so `resolveDailyCap` and the chain walker's
 * hop-time guard cannot drift on the classification.
 */
export function isOperatorFundedProvider(type: ProviderChainType): boolean {
  return type === "admin-openai" || type === "admin-codex";
}

/**
 * v1.37.19 (A7-2) — the day's recorded spend for one user (0 when no row).
 *
 * Read by the chain walker's hop-time operator-cap guard: a request whose
 * PRIMARY provider runs on the user's own key reserves under the generous
 * `USER_PLAN_CAP`, but the chain may still FALL BACK onto an operator-funded
 * `admin-*` entry (or the health-ledger reorder may promote one) — and that
 * hop must not spend past `OPERATOR_COST_CAP` just because the reservation
 * was checked against the wrong owner's ceiling.
 */
export async function readDailySpend(
  userId: string,
  dateKey: string = buildDateKey(),
): Promise<number> {
  const row = await prisma.coachUsage.findUnique({
    where: { userId_dateKey: { userId, dateKey } },
    select: { totalTokens: true },
  });
  return row?.totalTokens ?? 0;
}

/**
 * Build the UTC day-key for a given clock. Defaults to "now".
 *
 * UTC choice: the budget guards spend against the operator's LLM
 * bill — the bill cycles at the provider's UTC midnight, so aligning
 * the local meter to the same boundary keeps reasoning trivial.
 */
export function buildDateKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * v1.18.7 (SENIOR-DEV HIGH) — atomically reserve budget BEFORE the provider
 * call, closing the read-then-write TOCTOU window.
 *
 * `enforceBudget` reads spend, then `recordSpend` bumps it only AFTER a
 * successful reply, so up to `rate-limit` (20/min) concurrent requests could
 * each read `spent < cap` before any spend landed and all hit the provider.
 * This instead does a single atomic SQL upsert that increments the day's
 * total by an ESTIMATED reservation and returns the new total. The caller
 * checks the returned total against the cap: if the reservation pushed it
 * over, the request is refused and the reservation refunded; otherwise the
 * call proceeds and the actual token count is reconciled afterwards. Mirrors
 * the `rate-limit.ts` atomic-upsert pattern — multi-instance correctness is
 * structural, not a hopeful read-then-write.
 *
 * The first request of a fresh day still lands cheaply via the upsert
 * `create` branch; `messageCount` is bumped at reservation time so a
 * reserved-but-failed turn still counts as an attempt.
 */
export interface ReserveBudgetResult {
  /** True when the reservation kept the day's total within the cap. */
  allowed: boolean;
  /** Tokens reserved by this call (refunded/reconciled by the caller). */
  reserved: number;
  /** The day's total AFTER this reservation (for observability). */
  totalAfter: number;
}

export async function reserveBudget(
  userId: string,
  estimatedTokens: number,
  dateKey: string = buildDateKey(),
  cap: number = OPERATOR_COST_CAP,
): Promise<ReserveBudgetResult> {
  const reserved =
    Number.isFinite(estimatedTokens) && estimatedTokens > 0
      ? Math.floor(estimatedTokens)
      : 0;

  // Single atomic upsert-increment returning the new total. Two concurrent
  // requests serialise on the row's unique (user_id, date_key) constraint, so
  // each observes a distinct post-increment total — they cannot both read a
  // sub-cap value and both proceed.
  const rows = await prisma.$queryRaw<{ total_tokens: number }[]>`
    INSERT INTO coach_usage (id, user_id, date_key, total_tokens, message_count, created_at, updated_at)
    VALUES (gen_random_uuid()::text, ${userId}, ${dateKey}, ${reserved}, 1, NOW(), NOW())
    ON CONFLICT (user_id, date_key) DO UPDATE SET
      total_tokens = coach_usage.total_tokens + ${reserved},
      message_count = coach_usage.message_count + 1,
      updated_at = NOW()
    RETURNING total_tokens
  `;
  const totalAfter = Number(rows[0]?.total_tokens ?? reserved);

  // The cap is a ceiling on tokens already spent BEFORE this request, matching
  // the prior `spent >= cap` semantics: a request is allowed when the spend
  // PRIOR to its reservation was under the cap. So compare `totalAfter -
  // reserved` (the prior total) against the cap.
  const priorTotal = totalAfter - reserved;
  if (priorTotal >= cap) {
    // Already over before this request — refund the reservation + the
    // message-count bump and refuse.
    await refundReservation(userId, reserved, dateKey);
    return { allowed: false, reserved, totalAfter: priorTotal };
  }

  return { allowed: true, reserved, totalAfter };
}

/**
 * Reconcile a reservation against the actual tokens the provider reported.
 * `actual - reserved` is applied as a signed delta (clamped so the row never
 * goes negative). Called after every provider call — including empty /
 * sentinel / refusal replies, whose upstream tokens were still burned
 * (SENIOR-DEV MEDIUM: spend undercount).
 *
 * v1.21.0 (F3) — `cachedTokens` (the Responses-API `cached_tokens` count) is
 * subtracted from the charged amount. The gross `total_tokens` a reasoning
 * provider reports still includes the full input even when prompt-caching
 * served most of it cheaply / free; charging the user's daily meter for input
 * they did not re-pay for is an over-charge. We bill `actual - cached`.
 */
export async function reconcileSpend(
  userId: string,
  reserved: number,
  actualTokens: number,
  dateKey: string = buildDateKey(),
  cachedTokens = 0,
): Promise<void> {
  const grossActual =
    Number.isFinite(actualTokens) && actualTokens > 0
      ? Math.floor(actualTokens)
      : 0;
  const cached =
    Number.isFinite(cachedTokens) && cachedTokens > 0
      ? Math.floor(cachedTokens)
      : 0;
  // Bill net of cached input; clamp so a cached count larger than the gross
  // (shouldn't happen, but the wire is untrusted) can't drive a negative charge.
  const actual = Math.max(0, grossActual - cached);
  const delta = actual - reserved;
  if (delta === 0) return;
  // Clamp at zero so a smaller-than-reserved actual can't drive the row
  // negative under a racing reconcile.
  await prisma.$executeRaw`
    UPDATE coach_usage
    SET total_tokens = GREATEST(0, total_tokens + ${delta}),
        updated_at = NOW()
    WHERE user_id = ${userId} AND date_key = ${dateKey}
  `;
}

/** Refund a reservation (tokens + the message-count bump) on a refusal. */
async function refundReservation(
  userId: string,
  reserved: number,
  dateKey: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE coach_usage
    SET total_tokens = GREATEST(0, total_tokens - ${reserved}),
        message_count = GREATEST(0, message_count - 1),
        updated_at = NOW()
    WHERE user_id = ${userId} AND date_key = ${dateKey}
  `;
}

/**
 * The `enforceBudget` (read-then-write check) + `recordSpend` (post-hoc bump)
 * pair that preceded the reservation model is deliberately GONE, not
 * deprecated. It carried two defects that recurred every time a new surface
 * copied it: a TOCTOU window between the read and the write, and a `cap`
 * parameter that defaulted to `OPERATOR_COST_CAP`, so any caller that omitted
 * it rationed a self-hoster's own key by the operator's ceiling. Removing the
 * functions means a future surface cannot reintroduce either defect by
 * reaching for the older, simpler-looking helper —
 * `reserveBudget` / `reconcileSpend` with an explicit `resolveDailyCap(chain)`
 * is the only path left.
 */
