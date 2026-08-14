import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetCryptoCacheForTests } from "@/lib/crypto";
import {
  encryptDocumentSummary,
  serialiseDocumentDetail,
  type SerialisableDocument,
} from "@/lib/documents/store";

/**
 * What the detail DTO says about a summary has to match what the user can
 * actually see. The state column is the source of truth for the four outcomes,
 * with one exception the view depends on: a READY row whose ciphertext will not
 * open has no summary to render, so reporting READY would leave a heading over
 * nothing.
 */

const KEY_V1 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", KEY_V1);
  _resetCryptoCacheForTests();
});

function row(overrides: Partial<SerialisableDocument> = {}) {
  return {
    id: "doc-1",
    userId: "user-1",
    kind: "OTHER",
    title: "Discharge letter",
    filename: "letter.pdf",
    mimeType: "application/pdf",
    byteSize: 1024,
    contentCodec: "binary2",
    contentSha256: null,
    status: "STORED",
    providerType: null,
    reportDate: null,
    documentDate: null,
    errorReason: null,
    summaryEncrypted: null,
    summaryGeneratedAt: null,
    summaryState: "NONE",
    createdAt: new Date("2026-02-14T00:00:00Z"),
    updatedAt: new Date("2026-02-14T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  } as unknown as SerialisableDocument;
}

describe("serialiseDocumentDetail — summary state", () => {
  it("returns the stored summary as READY", () => {
    const dto = serialiseDocumentDetail(
      row({
        summaryEncrypted: encryptDocumentSummary("A discharge letter."),
        summaryGeneratedAt: new Date("2026-02-15T09:00:00Z"),
        summaryState: "READY",
      }),
      [],
    );

    expect(dto.summary).toBe("A discharge letter.");
    expect(dto.summaryState).toBe("READY");
    expect(dto.summaryGeneratedAt).toBe("2026-02-15T09:00:00.000Z");
  });

  it.each(["NONE", "WITHHELD", "UNAVAILABLE"] as const)(
    "passes %s through with no summary",
    (summaryState) => {
      const dto = serialiseDocumentDetail(row({ summaryState }), []);

      expect(dto.summary).toBeNull();
      expect(dto.summaryState).toBe(summaryState);
    },
  );

  it("passes a FRESH PENDING through — the job is credibly in flight", () => {
    const dto = serialiseDocumentDetail(
      row({ summaryState: "PENDING", updatedAt: new Date() }),
      [],
    );
    expect(dto.summaryState).toBe("PENDING");
  });

  // Watched red: with the stale-PENDING branch removed from
  // `serialiseDocumentDetail` (the pre-v1.37.19 serialiser), this case fails —
  // a summary job dead past its retry budget left the sheet saying
  // "generating" forever, with no manual action offered.
  it("degrades a PENDING older than the TTL to UNAVAILABLE", () => {
    const dto = serialiseDocumentDetail(
      row({
        summaryState: "PENDING",
        updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      }),
      [],
    );
    expect(dto.summary).toBeNull();
    expect(dto.summaryState).toBe("UNAVAILABLE");
  });

  it("degrades an undecryptable READY row to UNAVAILABLE", () => {
    // A rotated-away key. There is no summary to show, so the DTO must not
    // keep promising one — and the ciphertext is never returned either.
    const dto = serialiseDocumentDetail(
      row({
        summaryEncrypted: new TextEncoder().encode("not-ciphertext"),
        summaryState: "READY",
      }),
      [],
    );

    expect(dto.summary).toBeNull();
    expect(dto.summaryState).toBe("UNAVAILABLE");
  });

  it("degrades a READY row with no ciphertext at all to UNAVAILABLE", () => {
    const dto = serialiseDocumentDetail(
      row({ summaryEncrypted: null, summaryState: "READY" }),
      [],
    );

    expect(dto.summary).toBeNull();
    expect(dto.summaryState).toBe("UNAVAILABLE");
  });
});
