import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    insightStatusCache: { findUnique: vi.fn() },
  },
}));

// A reversible stand-in for the at-rest codec; what this file pins is which
// stored note becomes prompt context, not AES-GCM.
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: (plain: string) => new TextEncoder().encode(`enc:${plain}`),
  decryptFromBytes: (buf: Uint8Array) => {
    const text = new TextDecoder().decode(buf);
    if (!text.startsWith("enc:")) throw new Error("unknown key id");
    return text.slice(4);
  },
}));

import { prisma } from "@/lib/db";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "../memory";

function noteRow(text: string | null, generatedAt: Date | null) {
  return {
    textEncrypted:
      text === null ? null : new TextEncoder().encode(`enc:${text}`),
    itemsEncrypted: null,
    inputHash: null,
    snapshotHash: null,
    dateKey: "2026-05-01",
    generatedAt,
    retryAt: null,
    negativeReason: null,
  };
}

beforeEach(() => {
  vi.mocked(prisma.insightStatusCache.findUnique).mockReset();
});

describe("getPreviousInsightContext", () => {
  it("returns null when no stored note exists", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValueOnce(null);
    const ctx = await getPreviousInsightContext("u-1", "general-status", "en");
    expect(ctx).toBeNull();
  });

  it("returns null when the row carries no note (only a negative window)", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValueOnce(
      noteRow(null, null) as never,
    );
    const ctx = await getPreviousInsightContext("u-1", "general-status", "en");
    expect(ctx).toBeNull();
  });

  it("returns the stored note with its age", async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValueOnce(
      noteRow("Your BP averaged 130/80 — high-normal.", sevenDaysAgo) as never,
    );
    const ctx = await getPreviousInsightContext("u-1", "general-status", "en");
    expect(ctx).not.toBeNull();
    expect(ctx!.ageDays).toBe(7);
    expect(ctx!.text).toContain("130/80");
    expect(ctx!.generatedAt).toBe(sevenDaysAgo.toISOString());
  });

  it("caps the text length so a verbose snapshot cannot bloat the prompt", async () => {
    const big = "x".repeat(5000);
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValueOnce(
      noteRow(big, new Date(Date.now() - 86_400_000)) as never,
    );
    const ctx = await getPreviousInsightContext("u-1", "general-status", "en");
    expect(ctx!.text.length).toBeLessThanOrEqual(1502); // 1500 + "…"
    expect(ctx!.text.endsWith("…")).toBe(true);
  });

  it("filters by minAgeHours so today's earlier run isn't treated as 'previous'", async () => {
    // Written 23 h ago: inside a 24 h floor, so not "previous".
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValueOnce(
      noteRow("Earlier today.", new Date(Date.now() - 23 * 3_600_000)) as never,
    );
    expect(
      await getPreviousInsightContext("u-1", "general-status", "en", 24),
    ).toBeNull();
    const call = vi.mocked(prisma.insightStatusCache.findUnique).mock
      .calls[0]?.[0] as {
      where: { userId_metric_locale: Record<string, string> };
    };
    expect(call.where.userId_metric_locale).toEqual({
      userId: "u-1",
      metric: "general",
      locale: "en",
    });

    // Written 25 h ago: past the floor, so it is the previous analysis.
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValueOnce(
      noteRow("Yesterday.", new Date(Date.now() - 25 * 3_600_000)) as never,
    );
    const ctx = await getPreviousInsightContext(
      "u-1",
      "general-status",
      "en",
      24,
    );
    expect(ctx?.text).toBe("Yesterday.");
  });
});

describe("formatPreviousContextForPrompt", () => {
  it("returns a 'no history' instruction when ctx is null (English)", () => {
    const out = formatPreviousContextForPrompt(null, "en");
    expect(out).toContain("PREVIOUS ANALYSIS: none on file");
    expect(out).toContain("no improvement/regression delta to surface");
  });

  it("returns a 'no history' instruction when ctx is null (German)", () => {
    const out = formatPreviousContextForPrompt(null, "de");
    expect(out).toContain("VORHERIGE ANALYSE: keine vorhanden");
  });

  it("formats a 7-days-ago context with date + text + comparison instruction (English)", () => {
    const out = formatPreviousContextForPrompt(
      {
        generatedAt: "2026-05-01T08:00:00.000Z",
        ageDays: 7,
        text: "Your BP averaged 130/80 last week.",
      },
      "en",
    );
    expect(out).toContain("PREVIOUS ANALYSIS (7 days ago, 2026-05-01)");
    expect(out).toContain("Your BP averaged 130/80 last week.");
    expect(out).toContain('"down 4 mmHg from your last check"');
  });

  it("formats a same-day context (German)", () => {
    const out = formatPreviousContextForPrompt(
      {
        generatedAt: "2026-05-08T06:00:00.000Z",
        ageDays: 0,
        text: "Frühanalyse: 130/80 grenzwertig.",
      },
      "de",
    );
    expect(out).toContain("VORHERIGE ANALYSE (heute früher, 2026-05-08)");
    expect(out).toContain("Frühanalyse: 130/80 grenzwertig.");
  });
});
