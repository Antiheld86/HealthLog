/**
 * v1.39.4 — an earlier table keeps its `m<k>` name once the conversation
 * outgrows the window the turn loads: the index counts the assistant
 * messages before the window too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  fetchConversationWithMessages: vi.fn(),
  countAssistantMessagesBefore: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/ai/coach/persistence", () => ({
  CONVERSATION_MESSAGE_DETAIL_CAP: 200,
  appendMessage: vi.fn(),
  createConversation: vi.fn(),
  fetchConversationWithMessages: m.fetchConversationWithMessages,
  countAssistantMessagesBefore: m.countAssistantMessagesBefore,
}));

import { resolveTurnConversation } from "../conversation";

const TABLE = {
  ref: "r1",
  source: {
    tool: "get_metric_table",
    domain: "bp",
    window: "last30days",
    period: "current",
  },
  shape: "timeSeries",
  titleKey: "t",
  title: "t",
  rowCount: 30,
  chartKind: null,
  displayed: true,
};

/** `n` messages alternating user / assistant, the last one holding a table. */
function window(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: "x",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    metricSource: i === n - 1 ? { results: [TABLE] } : null,
    providerType: i % 2 === 0 ? null : "openai",
  }));
}

async function priorOf(messages: ReturnType<typeof window>) {
  m.fetchConversationWithMessages.mockResolvedValue({
    id: "c1",
    messages,
    attachmentCount: 0,
    summary: null,
  });
  const out = await resolveTurnConversation({
    userId: "u1",
    conversationId: "c1",
    message: "hi",
    locale: "en",
  });
  if (!("conversation" in out)) throw new Error("refused");
  return out.conversation.priorResults ?? [];
}

beforeEach(() => {
  m.fetchConversationWithMessages.mockReset();
  m.countAssistantMessagesBefore.mockReset();
});

describe("prior table names across the loaded window", () => {
  it("counts the assistant messages before a full window", async () => {
    m.countAssistantMessagesBefore.mockResolvedValue(40);
    const prior = await priorOf(window(200));
    // 100 assistant messages in the window, 40 before it.
    expect(prior.map((p) => p.turnIndex)).toEqual([140]);
    expect(m.countAssistantMessagesBefore).toHaveBeenCalledWith(
      "c1",
      new Date(Date.UTC(2026, 0, 1, 0, 0)),
    );
  });

  it("reads no count while the whole conversation is loaded", async () => {
    const prior = await priorOf(window(10));
    expect(prior.map((p) => p.turnIndex)).toEqual([5]);
    expect(m.countAssistantMessagesBefore).not.toHaveBeenCalled();
  });
});
