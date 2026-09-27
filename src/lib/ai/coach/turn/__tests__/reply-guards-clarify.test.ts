/**
 * v1.39.4 — a clarifying question through the reply guards: the block never
 * reaches the prose, a block with no question is an unusable reply, a second
 * question in a row gets no card, and a blocked reply carries no choices.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { coachMessage: { findMany: (...a: unknown[]) => findMany(...a) } },
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/ai/coach/reminders", () => ({
  parseRememberSentinel: (prose: string) => ({ prose, reminder: null }),
  captureReminderFromSentinel: vi.fn(),
}));

import { guardReply } from "../reply-guards";
import type { TurnContext } from "../context";
import type { ModelOutcome } from "../model";
import type { TurnConversation } from "../types";

const INVENTORY = ["pulse", "resting_hr", "walking_hr"].map((metric) => ({
  tool: "get_metric_series",
  metric,
  domain: metric,
  present: true,
}));

function run(content: string) {
  const model = {
    ok: true,
    result: { content },
    toolTrace: [],
    toolResultPayloads: [],
    inventoryPayloads: [],
    noToolsSnapshotPayloads: [],
    inventory: INVENTORY,
    steps: [],
    results: [],
    forcedFinal: false,
  } as unknown as Extract<ModelOutcome, { ok: true }>;
  const ctx = {
    scheduleDoses: [],
    aboutMe: null,
    turnContext: { guidedBlock: "", includeFullSnapshot: false },
    snapshot: { referenceGrounding: null },
  } as unknown as TurnContext;
  const conversation: TurnConversation = {
    conversationId: "conv1",
    priorTurns: [],
    priorUserMessages: [],
    priorToolFigures: [],
    priorSummary: null,
  };
  return guardReply({
    userId: "u1",
    locale: "en",
    conversation,
    ctx,
    toolMode: true,
    model,
  });
}

const QUESTION = [
  "Which pulse do you mean?",
  "---CLARIFY---",
  "kind: metric",
  "choices: pulse, resting_hr, walking_hr",
  "---END---",
].join("\n");

describe("guardReply — clarification", () => {
  beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([
      { id: "m1", role: "user", providerType: null, metricSourceJson: null },
    ]);
  });

  it("strips the block and carries the validated choices", async () => {
    const out = await run(QUESTION);
    if (!out.ok) throw new Error(out.code);
    expect(out.reply.replyText).toBe("Which pulse do you mean?");
    expect(out.reply.clarification?.choices).toHaveLength(3);
  });

  it("treats a block with no question as an empty reply", async () => {
    const out = await run(
      "---CLARIFY---\nkind: metric\nchoices: pulse, resting_hr\n---END---",
    );
    expect(out).toEqual({ ok: false, code: "coach.provider.empty" });
  });

  it("never asks twice in a row", async () => {
    findMany.mockResolvedValue([
      { id: "m2", role: "user", providerType: null, metricSourceJson: null },
      {
        id: "m1",
        role: "assistant",
        providerType: "openai",
        metricSourceJson: JSON.stringify({
          windows: [],
          metrics: [],
          clarification: { kind: "context", choices: [], freeText: true },
        }),
      },
    ]);
    const out = await run(QUESTION);
    if (!out.ok) throw new Error(out.code);
    expect(out.reply.replyText).toBe("Which pulse do you mean?");
    expect(out.reply.clarification).toBeNull();
  });
});
