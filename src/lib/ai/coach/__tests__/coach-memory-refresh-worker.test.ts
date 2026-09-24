import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForJob: vi.fn(),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("../conversation-summary", () => ({
  refreshConversationSummary: vi.fn(async () => ({ status: "refreshed" })),
}));
vi.mock("../facts", () => ({
  extractAndStoreFacts: vi.fn(async () => ({ status: "stored", count: 1 })),
}));
vi.mock("../plans", () => ({
  extractAndStorePlanProposals: vi.fn(async () => ({
    status: "stored",
    count: 0,
  })),
}));

import { aiCapabilityForJob } from "@/lib/ai/capabilities/gate";
import { annotate } from "@/lib/logging/context";
import { runCoachMemoryRefresh } from "../coach-memory-refresh-worker";
import { refreshConversationSummary } from "../conversation-summary";
import { extractAndStoreFacts } from "../facts";
import { extractAndStorePlanProposals } from "../plans";

const payload = { conversationId: "c1", userId: "u1", locale: "en" as const };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runCoachMemoryRefresh", () => {
  it("runs all three steps when the Coach is available", async () => {
    vi.mocked(aiCapabilityForJob).mockResolvedValue({
      available: true,
      reason: null,
      onDeviceAllowed: true,
    });
    await runCoachMemoryRefresh(payload);
    expect(aiCapabilityForJob).toHaveBeenCalledWith("u1", "coach");
    expect(refreshConversationSummary).toHaveBeenCalled();
    expect(extractAndStoreFacts).toHaveBeenCalled();
    expect(extractAndStorePlanProposals).toHaveBeenCalled();
  });

  it.each(["operator_disabled", "user_disabled", "consent_required"] as const)(
    "reads no transcript and runs no step when the Coach is unavailable (%s)",
    async (reason) => {
      vi.mocked(aiCapabilityForJob).mockResolvedValue({
        available: false,
        reason,
        onDeviceAllowed: false,
      });
      await runCoachMemoryRefresh(payload);
      expect(refreshConversationSummary).not.toHaveBeenCalled();
      expect(extractAndStoreFacts).not.toHaveBeenCalled();
      expect(extractAndStorePlanProposals).not.toHaveBeenCalled();
      expect(annotate).toHaveBeenCalledWith({
        action: { name: "coach.memory.refresh.skipped" },
        meta: { reason },
      });
    },
  );
});
