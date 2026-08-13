/**
 * The honest-wait derivation for a document-AI 429. The routes mirror the
 * bucket's reset instant into `meta.retryAt`; the client turns it into "try
 * again in about N minutes". This pins the mapping: only a document-AI
 * rate-limit error yields minutes, the floor is one minute, and anything
 * malformed falls back to null (the generic copy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-fetch";

import { documentAiRetryMinutes } from "../use-document-assist";

const NOW = new Date("2026-08-12T12:00:00.000Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function rateLimited(retryAt?: unknown): ApiError {
  return new ApiError("Too many document AI requests this hour.", 429, {
    errorCode: "documents.inbound.rateLimited",
    ...(retryAt !== undefined ? { retryAt } : {}),
  });
}

describe("documentAiRetryMinutes", () => {
  it("derives whole minutes from the reset instant, rounding up", () => {
    const err = rateLimited(new Date(NOW + 42.4 * 60_000).toISOString());
    expect(documentAiRetryMinutes(err)).toBe(43);
  });

  it("floors at one minute for a reset only seconds away", () => {
    const err = rateLimited(new Date(NOW + 20_000).toISOString());
    expect(documentAiRetryMinutes(err)).toBe(1);
  });

  it("returns null when the error carries no usable instant", () => {
    expect(documentAiRetryMinutes(rateLimited())).toBeNull();
    expect(documentAiRetryMinutes(rateLimited("soon"))).toBeNull();
    expect(documentAiRetryMinutes(rateLimited(42))).toBeNull();
  });

  it("returns null for any other error class", () => {
    expect(
      documentAiRetryMinutes(
        new ApiError("Budget", 429, {
          errorCode: "documents.inbound.budgetExceeded",
        }),
      ),
    ).toBeNull();
    expect(documentAiRetryMinutes(new Error("network"))).toBeNull();
  });
});
