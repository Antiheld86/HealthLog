/**
 * v1.39.4 — an earlier table keeps its `m<k>` name once the conversation
 * outgrows the window the turn loads: the index counts the assistant
 * messages before the window too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    coachConversation: { findFirst: m.findFirst },
    coachMessage: { count: m.count },
  },
}));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: vi.fn(),
  decryptFromBytes: vi.fn(() => "x"),
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));

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

/**
 * The newest `n` messages as the detail read returns them (newest first),
 * alternating user / assistant, the newest assistant one holding a table.
 */
function rows(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const age = i; // 0 = newest
    const assistant = age % 2 === 0;
    return {
      id: `m${n - age}`,
      role: assistant ? "assistant" : "user",
      encryptedContent: new Uint8Array(),
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, n - age)),
      metricSourceJson:
        age === 0
          ? JSON.stringify({ windows: [], metrics: [], results: [TABLE] })
          : null,
      providerType: assistant ? "openai" : null,
      promptVersion: null,
      tokensUsed: null,
      model: null,
    };
  });
}

async function priorOf(messages: ReturnType<typeof rows>) {
  m.findFirst.mockResolvedValue({
    id: "c1",
    titleEncrypted: null,
    title: "t",
    createdAt: new Date(),
    updatedAt: new Date(),
    documentScoped: false,
    summaryEncrypted: null,
    messages,
    attachments: [],
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
  m.findFirst.mockReset();
  m.count.mockReset();
});

describe("prior table names across the loaded window", () => {
  it("counts the assistant messages before a full window", async () => {
    m.count.mockResolvedValue(40);
    const prior = await priorOf(rows(200));
    // 100 assistant messages in the window, 40 before it.
    expect(prior.map((p) => p.turnIndex)).toEqual([140]);
    expect(m.count).toHaveBeenCalledWith({
      where: {
        conversationId: "c1",
        role: "assistant",
        createdAt: { lt: new Date(Date.UTC(2026, 0, 1, 0, 1)) },
      },
    });
  });

  it("reads no count while the whole conversation is loaded", async () => {
    const prior = await priorOf(rows(10));
    expect(prior.map((p) => p.turnIndex)).toEqual([5]);
    expect(m.count).not.toHaveBeenCalled();
  });
});
