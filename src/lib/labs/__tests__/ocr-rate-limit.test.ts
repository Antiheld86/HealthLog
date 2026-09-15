import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  refundRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({ "Retry-After": "1800" })),
}));

import {
  checkLabsOcrRateLimit,
  labsOcrRateLimited,
  refundLabsOcrSlot,
  resolveLabsOcrLimitPerHour,
} from "../ocr-rate-limit";
import { checkRateLimit, refundRateLimit } from "@/lib/rate-limit";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("LABS_OCR_LIMIT_PER_HOUR", () => {
  it("defaults to 6 when unset or not a number", () => {
    vi.stubEnv("LABS_OCR_LIMIT_PER_HOUR", "");
    expect(resolveLabsOcrLimitPerHour()).toBe(6);
    vi.stubEnv("LABS_OCR_LIMIT_PER_HOUR", "lots");
    expect(resolveLabsOcrLimitPerHour()).toBe(6);
  });

  it("uses an operator value inside the range", () => {
    vi.stubEnv("LABS_OCR_LIMIT_PER_HOUR", "40");
    expect(resolveLabsOcrLimitPerHour()).toBe(40);
  });

  it("clamps to 1-1000 so a typo can neither switch scans off nor remove the cap", () => {
    vi.stubEnv("LABS_OCR_LIMIT_PER_HOUR", "0");
    expect(resolveLabsOcrLimitPerHour()).toBe(1);
    vi.stubEnv("LABS_OCR_LIMIT_PER_HOUR", "-5");
    expect(resolveLabsOcrLimitPerHour()).toBe(1);
    vi.stubEnv("LABS_OCR_LIMIT_PER_HOUR", "50000");
    expect(resolveLabsOcrLimitPerHour()).toBe(1000);
  });

  it("charges the existing bucket key with the resolved ceiling and an hour window", async () => {
    vi.stubEnv("LABS_OCR_LIMIT_PER_HOUR", "25");
    await checkLabsOcrRateLimit("user-1");
    expect(checkRateLimit).toHaveBeenCalledWith(
      "labs-ocr:user-1",
      25,
      60 * 60 * 1000,
    );
  });

  it("refunds the same bucket and never throws when the refund fails", async () => {
    vi.mocked(refundRateLimit).mockRejectedValueOnce(new Error("db down"));
    await expect(refundLabsOcrSlot("user-1")).resolves.toBeUndefined();
    expect(refundRateLimit).toHaveBeenCalledWith("labs-ocr:user-1");
  });

  it("names the reset instant on the 429", async () => {
    const resetAt = Date.parse("2026-09-15T15:00:00Z");
    const res = labsOcrRateLimited({
      allowed: false,
      remaining: 0,
      resetAt,
    } as never);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1800");
    const body = (await res.json()) as {
      meta: { errorCode: string; retryAt: string };
    };
    expect(body.meta.errorCode).toBe("labs.ocr.rateLimited");
    expect(body.meta.retryAt).toBe("2026-09-15T15:00:00.000Z");
  });
});
