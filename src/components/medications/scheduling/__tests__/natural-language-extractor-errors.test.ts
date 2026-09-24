/**
 * The medication text reader says why it could not read, from the refusal's
 * code. Before, a spent daily budget (429 `coach.budget.exceeded`) showed the
 * rate-limit sentence, and a switched-off reader or a missing consent showed
 * "check your connection".
 */
import { describe, expect, it } from "vitest";

import { classifyExtractFailure } from "../natural-language-extractor";

const envelope = (errorCode?: string, error = "refused") => ({
  data: null,
  error,
  ...(errorCode ? { meta: { errorCode } } : {}),
});

describe("classifyExtractFailure", () => {
  it("reads the code before the status", () => {
    expect(
      classifyExtractFailure(429, envelope("coach.budget.exceeded")).kind,
    ).toBe("budget");
    expect(classifyExtractFailure(429, envelope()).kind).toBe("rateLimit");
  });

  it("names a missing provider, a missing consent and a switched-off reader", () => {
    expect(classifyExtractFailure(503, envelope("ai.provider.none")).kind).toBe(
      "noProvider",
    );
    expect(
      classifyExtractFailure(403, envelope("consent.ai.required")).kind,
    ).toBe("consent");
    expect(
      classifyExtractFailure(403, envelope("assistant.disabled.documentAi"))
        .kind,
    ).toBe("unavailable");
    expect(
      classifyExtractFailure(403, envelope("ai.record.notPermitted")).kind,
    ).toBe("unavailable");
  });

  it("keeps a bare 503 as no provider and anything else as a network failure", () => {
    expect(classifyExtractFailure(503, null).kind).toBe("noProvider");
    expect(classifyExtractFailure(500, envelope()).kind).toBe("network");
  });
});
