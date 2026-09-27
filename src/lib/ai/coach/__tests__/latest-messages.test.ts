/**
 * v1.39.4 — a turn reads its conversation's newest messages once, and the
 * chip, clarification, "keep looking" and repeat-question checks share it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { coachMessage: { findMany: (...a: unknown[]) => findMany(...a) } },
}));

import { latestMessagesOnce } from "../latest-messages";
import { resolveFollowUp } from "../follow-ups/resolve";
import { resolveContinuation } from "../follow-ups/continue";
import {
  dropRepeatClarification,
  resolveClarificationAnswer,
} from "../clarify";

beforeEach(() => findMany.mockReset());

describe("latestMessagesOnce", () => {
  it("serves every check of a turn from one owner-narrowed read", async () => {
    findMany.mockResolvedValue([
      {
        id: "m-a",
        role: "assistant",
        providerType: "openai",
        metricSourceJson: null,
      },
    ]);
    const latest = latestMessagesOnce("u1", "c1");
    const followUp = { messageId: "m-a", id: "f1" };
    await resolveFollowUp({
      userId: "u1",
      conversationId: "c1",
      followUp,
      latest,
    });
    await resolveClarificationAnswer({
      userId: "u1",
      conversationId: "c1",
      clarification: { messageId: "m-a" },
      latest,
    });
    await resolveContinuation({
      userId: "u1",
      conversationId: "c1",
      followUp,
      priorResults: [],
      latest,
    });
    await dropRepeatClarification({
      userId: "u1",
      conversationId: "c1",
      clarification: { kind: "window", choices: [], freeText: true },
      latest,
    });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { conversationId: "c1", conversation: { userId: "u1" } },
      take: 4,
    });
  });

  it("reads again after a failed read", async () => {
    findMany.mockRejectedValueOnce(new Error("connection reset"));
    findMany.mockResolvedValueOnce([]);
    const latest = latestMessagesOnce("u1", "c1");
    await expect(latest()).rejects.toThrow("connection reset");
    await expect(latest()).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
