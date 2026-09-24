/**
 * Consent contract for the AI-composed proactive Coach nudge.
 *
 * The nudge sends less PHI than the Coach chat (an abstract trigger topic plus
 * the deterministic template body — never the user's own words or figures), but
 * it is still the user's health situation leaving the server, it runs
 * unattended on the 05:15 tick, and the chain can end at the operator's
 * server-managed credential. So it carries the same receipt requirement.
 *
 * The gate is skip-shaped: no receipt → `null` → the caller ships the
 * deterministic template, so the nudge itself is never lost.
 *
 * Only the receipt table (`prisma.consentReceipt`) is mocked, not the wire
 * re-check, so the real `aiEgressRefusal` rule runs: the capability again (a
 * job, so `aiCapabilityForJob`), then whether exactly this chain needs a
 * receipt under the `coach` capability's rule, then whether one is active.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The active receipt kinds the record holds; `findFirst` answers from them. */
const activeKinds = vi.hoisted(() => ({ current: [] as string[] }));
const consentReceiptFindFirst = vi.hoisted(() =>
  vi.fn(async (args: { where: { kind: { in: string[] } } }) =>
    args.where.kind.in.some((kind) => activeKinds.current.includes(kind))
      ? { id: "receipt-1" }
      : null,
  ),
);
vi.mock("@/lib/db", () => ({
  prisma: { consentReceipt: { findFirst: consentReceiptFindFirst } },
}));
vi.mock("@/lib/documents/document-settings", () => ({
  documentAutoReadEnabled: vi.fn(async () => false),
}));

const resolveProviderChain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/provider", () => ({ resolveProviderChain }));

const budgetMocks = vi.hoisted(() => ({
  buildDateKey: vi.fn(() => "2026-07-18"),
  reserveBudget: vi.fn(async () => ({
    allowed: true,
    reserved: 160,
    totalAfter: 160,
  })),
  reconcileSpend: vi.fn(async () => {}),
  resolveDailyCap: vi.fn(() => 200_000),
  resolveDailyCapFor: vi.fn(() => 200_000),
  resolveCostOwner: vi.fn(() => "operator" as const),
}));
vi.mock("@/lib/ai/coach/budget", () => budgetMocks);

// No request event: the nudge runs off-request, which is the arm of
// `aiEgressRefusal` that resolves the capability for the job's record.
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => undefined),
}));

// The composer resolves the `coach` capability before the chain. Available
// by default so the consent logic below is what each case exercises.
const aiCapabilityForJob = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForJob,
  aiCapabilityForRecord: vi.fn(),
}));

import {
  composeNudgeWithAI,
  createNudgeAiTickBudget,
  type ComposeNudgeParams,
} from "../coach-nudge-ai";
import { annotate } from "@/lib/logging/context";

function makeProvider() {
  return {
    type: "openai",
    generateCompletion: vi.fn(async () => ({
      content: "Your rhythm has shifted a little this week — worth a look?",
      model: "gpt-4o",
      tokensUsed: 90,
      cachedInputTokens: 0,
    })),
  };
}

let provider: ReturnType<typeof makeProvider>;

function params(): ComposeNudgeParams {
  return {
    userId: "user-1",
    trigger: "compliance",
    locale: "en",
    name: "A",
    hasCoachFocus: false,
    template: { title: "Morning", body: "A gentle deterministic body." },
    tickBudget: createNudgeAiTickBudget(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  provider = makeProvider();
  activeKinds.current = [];
  aiCapabilityForJob.mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
  budgetMocks.reserveBudget.mockResolvedValue({
    allowed: true,
    reserved: 160,
    totalAfter: 160,
  });
});

describe("composeNudgeWithAI — server-managed consent gate", () => {
  it("skips AI composition on an operator-managed chain with no receipt", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "admin-openai", instance: provider },
    ]);

    const out = await composeNudgeWithAI(params());

    // null = the caller keeps the deterministic template.
    expect(out).toBeNull();
    expect(provider.generateCompletion).not.toHaveBeenCalled();
  });

  it("burns neither a budget reservation nor a per-tick slot when refused", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "admin-openai", instance: provider },
    ]);
    const p = params();

    await composeNudgeWithAI(p);

    expect(budgetMocks.reserveBudget).not.toHaveBeenCalled();
    expect(p.tickBudget.remainingCount).toBe(
      createNudgeAiTickBudget().remainingCount,
    );
  });

  it("skips on the operator-shared central Codex with no receipt", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "admin-codex", instance: provider },
    ]);

    expect(await composeNudgeWithAI(params())).toBeNull();
    expect(provider.generateCompletion).not.toHaveBeenCalled();
  });

  it("composes once an ai_coach receipt is active", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "admin-openai", instance: provider },
    ]);
    activeKinds.current = ["ai_coach"];

    const out = await composeNudgeWithAI(params());

    expect(out).not.toBeNull();
    expect(out?.body).toBe(
      "Your rhythm has shifted a little this week — worth a look?",
    );
    expect(provider.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it("accepts the master ai_full grant", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "admin-openai", instance: provider },
    ]);
    activeKinds.current = ["ai_full"];

    expect(await composeNudgeWithAI(params())).not.toBeNull();
    expect(provider.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it("does not count a receipt of an unrelated kind", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "admin-openai", instance: provider },
    ]);
    activeKinds.current = ["ai_extraction"];

    expect(await composeNudgeWithAI(params())).toBeNull();
    expect(provider.generateCompletion).not.toHaveBeenCalled();
    expect(annotate).toHaveBeenCalledWith({
      action: { name: "coach.nudge.ai.refused" },
      meta: { reason: "consent_required" },
    });
  });

  it("leaves a BYOK chain ungated — the user's own egress needs no receipt", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "openai", instance: provider },
    ]);

    expect(await composeNudgeWithAI(params())).not.toBeNull();
    expect(provider.generateCompletion).toHaveBeenCalledTimes(1);
    expect(consentReceiptFindFirst).not.toHaveBeenCalled();
  });

  it("fails closed when a server-managed entry sits BEHIND a BYOK primary", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "openai", instance: provider },
      { providerType: "admin-openai", instance: provider },
    ]);

    expect(await composeNudgeWithAI(params())).toBeNull();
    expect(provider.generateCompletion).not.toHaveBeenCalled();
  });

  it("returns the template before resolving any chain when the coach capability is unavailable", async () => {
    aiCapabilityForJob.mockResolvedValue({
      available: false,
      reason: "user_disabled",
      onDeviceAllowed: false,
    });
    resolveProviderChain.mockResolvedValue([
      { providerType: "openai", instance: provider },
    ]);
    const p = params();

    expect(await composeNudgeWithAI(p)).toBeNull();
    expect(aiCapabilityForJob).toHaveBeenCalledWith("user-1", "coach");
    expect(resolveProviderChain).not.toHaveBeenCalled();
    expect(budgetMocks.reserveBudget).not.toHaveBeenCalled();
    expect(provider.generateCompletion).not.toHaveBeenCalled();
    expect(p.tickBudget.remainingCount).toBe(
      createNudgeAiTickBudget().remainingCount,
    );
  });
});
