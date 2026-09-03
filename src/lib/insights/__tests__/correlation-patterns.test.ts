import { beforeEach, describe, expect, it, vi } from "vitest";

interface StoredPattern {
  id: string;
  userId: string;
  canonicalKey: string;
  family: string;
  factorKey: string;
  outcomeKey: string;
  lagDays: number;
  sampleSize: number;
  effectSize: number;
  pValue: number;
  qValue: number | null;
  evidenceHash: string;
  isCurrent: boolean;
  lastComputedAt: Date;
  dismissedAt: Date | null;
  dismissedEvidenceHash: string | null;
  dismissedEffectSize: number | null;
  dismissedSampleSize: number | null;
}

const rows = new Map<string, StoredPattern>();
const correlationPattern = {
  findMany: vi.fn(
    async ({
      where,
    }: {
      where: { userId: string; canonicalKey: { in: string[] } };
    }) =>
      [...rows.values()].filter(
        (row) =>
          row.userId === where.userId &&
          where.canonicalKey.in.includes(row.canonicalKey),
      ),
  ),
  updateMany: vi.fn(
    async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: { isCurrent: boolean };
    }) => {
      let count = 0;
      for (const row of rows.values()) {
        const notIn = (where.canonicalKey as { notIn?: string[] } | undefined)
          ?.notIn;
        if (
          row.userId === where.userId &&
          row.family === where.family &&
          row.isCurrent === where.isCurrent &&
          (!notIn || !notIn.includes(row.canonicalKey))
        ) {
          row.isCurrent = data.isCurrent;
          count += 1;
        }
      }
      return { count };
    },
  ),
  upsert: vi.fn(
    async ({
      where,
      create,
      update,
    }: {
      where: { userId_canonicalKey: { userId: string; canonicalKey: string } };
      create: Omit<
        StoredPattern,
        | "id"
        | "dismissedAt"
        | "dismissedEvidenceHash"
        | "dismissedEffectSize"
        | "dismissedSampleSize"
      >;
      update: Partial<StoredPattern>;
    }) => {
      const key = `${where.userId_canonicalKey.userId}:${where.userId_canonicalKey.canonicalKey}`;
      const prior = rows.get(key);
      if (prior) {
        Object.assign(prior, update);
        return prior;
      }
      const created: StoredPattern = {
        id: `pattern-${rows.size + 1}`,
        ...create,
        dismissedAt: null,
        dismissedEvidenceHash: null,
        dismissedEffectSize: null,
        dismissedSampleSize: null,
      };
      rows.set(key, created);
      return created;
    },
  ),
};

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: (
      fn: (tx: { correlationPattern: typeof correlationPattern }) => unknown,
    ) => fn({ correlationPattern }),
  },
}));

import {
  canonicalPatternKey,
  isMaterialEvidenceChange,
  PATTERN_FAMILIES,
  shouldReleaseDismissal,
  syncAcceptedPatterns,
} from "@/lib/insights/correlation-patterns";

const baseEvidence = {
  factorKey: "TAG:alcohol",
  outcomeKey: "CROSSTAB:RESTING_HEART_RATE",
  lagDays: 1,
  sampleSize: 40,
  effectSize: 0.3,
  pValue: 0.01,
  qValue: 0.04,
};

describe("correlation pattern identity and dismissal", () => {
  beforeEach(() => {
    rows.clear();
    vi.clearAllMocks();
  });

  it("uses the same canonical identity across recomputation", () => {
    expect(canonicalPatternKey("factor", "outcome", 1)).toBe(
      canonicalPatternKey("factor", "outcome", 1),
    );
    expect(canonicalPatternKey("factor", "outcome", 0)).not.toBe(
      canonicalPatternKey("factor", "outcome", 1),
    );
  });

  it("retains an unchanged dismissal, resurfaces material evidence, and retires stale findings", async () => {
    const first = await syncAcceptedPatterns({
      userId: "owner-1",
      family: PATTERN_FAMILIES.moodTagCrosstab,
      accepted: [baseEvidence],
      computedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const decision = [...first.values()][0];
    const row = [...rows.values()][0];
    row.dismissedAt = new Date("2026-07-02T00:00:00.000Z");
    row.dismissedEvidenceHash = row.evidenceHash;
    row.dismissedEffectSize = row.effectSize;
    row.dismissedSampleSize = row.sampleSize;

    const unchanged = await syncAcceptedPatterns({
      userId: "owner-1",
      family: PATTERN_FAMILIES.moodTagCrosstab,
      accepted: [{ ...baseEvidence, sampleSize: 45, effectSize: 0.35 }],
    });
    expect(unchanged.get(decision.canonicalKey)?.dismissed).toBe(true);

    const changed = await syncAcceptedPatterns({
      userId: "owner-1",
      family: PATTERN_FAMILIES.moodTagCrosstab,
      accepted: [{ ...baseEvidence, sampleSize: 50, effectSize: -0.2 }],
    });
    expect(changed.get(decision.canonicalKey)?.dismissed).toBe(false);
    expect(row.dismissedAt).toBeNull();

    await syncAcceptedPatterns({
      userId: "owner-1",
      family: PATTERN_FAMILIES.moodTagCrosstab,
      accepted: [],
    });
    expect(row.isCurrent).toBe(false);
  });

  it("defines material movement deterministically", () => {
    expect(
      isMaterialEvidenceChange({
        currentEffectSize: 0.39,
        currentSampleSize: 49,
        dismissedEffectSize: 0.3,
        dismissedSampleSize: 40,
      }),
    ).toBe(false);
    expect(
      isMaterialEvidenceChange({
        currentEffectSize: 0.4,
        currentSampleSize: 40,
        dismissedEffectSize: 0.3,
        dismissedSampleSize: 40,
      }),
    ).toBe(true);
    expect(
      isMaterialEvidenceChange({
        currentEffectSize: 0.3,
        currentSampleSize: 50,
        dismissedEffectSize: 0.3,
        dismissedSampleSize: 40,
      }),
    ).toBe(true);
  });
});

/**
 * `dismissedEvidenceHash` was written on every dismissal and read by nothing:
 * the gate compared effect size and sample size only. These tests pin it as a
 * reader, in both directions.
 */
describe("dismissal release against the stored evidence hash", () => {
  const DISMISSED_AT = new Date("2026-07-02T00:00:00.000Z");

  it("holds a dismissal whose evidence has not moved at all", () => {
    expect(
      shouldReleaseDismissal({
        dismissedAt: DISMISSED_AT,
        dismissedEvidenceHash: "a".repeat(64),
        dismissedEffectSize: 0.3,
        dismissedSampleSize: 40,
        currentEvidenceHash: "a".repeat(64),
        currentEffectSize: 0.3,
        currentSampleSize: 40,
      }),
    ).toBe(false);
  });

  it("releases a dismissal whose evidence moved materially", () => {
    expect(
      shouldReleaseDismissal({
        dismissedAt: DISMISSED_AT,
        dismissedEvidenceHash: "a".repeat(64),
        dismissedEffectSize: 0.3,
        dismissedSampleSize: 40,
        currentEvidenceHash: "b".repeat(64),
        currentEffectSize: -0.2,
        currentSampleSize: 40,
      }),
    ).toBe(true);
  });

  it("holds a dismissal whose evidence moved only within the noise band", () => {
    expect(
      shouldReleaseDismissal({
        dismissedAt: DISMISSED_AT,
        dismissedEvidenceHash: "a".repeat(64),
        dismissedEffectSize: 0.3,
        dismissedSampleSize: 40,
        currentEvidenceHash: "b".repeat(64),
        currentEffectSize: 0.35,
        currentSampleSize: 45,
      }),
    ).toBe(false);
  });

  it("releases a snapshot that has only a hash once that hash no longer matches", () => {
    expect(
      shouldReleaseDismissal({
        dismissedAt: DISMISSED_AT,
        dismissedEvidenceHash: "a".repeat(64),
        dismissedEffectSize: null,
        dismissedSampleSize: null,
        currentEvidenceHash: "b".repeat(64),
        currentEffectSize: 0.3,
        currentSampleSize: 40,
      }),
    ).toBe(true);
  });

  it("holds a snapshot that has only a hash while that hash still matches", () => {
    expect(
      shouldReleaseDismissal({
        dismissedAt: DISMISSED_AT,
        dismissedEvidenceHash: "a".repeat(64),
        dismissedEffectSize: null,
        dismissedSampleSize: null,
        currentEvidenceHash: "a".repeat(64),
        currentEffectSize: 0.3,
        currentSampleSize: 40,
      }),
    ).toBe(false);
  });

  it("holds a pattern that was never dismissed", () => {
    expect(
      shouldReleaseDismissal({
        dismissedAt: null,
        dismissedEvidenceHash: null,
        dismissedEffectSize: null,
        dismissedSampleSize: null,
        currentEvidenceHash: "b".repeat(64),
        currentEffectSize: 0.9,
        currentSampleSize: 400,
      }),
    ).toBe(false);
  });
});

describe("syncAcceptedPatterns honours the stored hash", () => {
  beforeEach(() => {
    rows.clear();
    vi.clearAllMocks();
  });

  it("resurfaces a hash-only dismissal on the next run and leaves an unchanged one dismissed", async () => {
    const first = await syncAcceptedPatterns({
      userId: "owner-2",
      family: PATTERN_FAMILIES.moodTagCrosstab,
      accepted: [baseEvidence],
      computedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const canonicalKey = [...first.values()][0].canonicalKey;
    const row = [...rows.values()][0];

    // A dismissal snapshot carrying the hash and nothing else — the shape a
    // partial restore leaves behind. It used to be frozen dismissed forever.
    row.dismissedAt = new Date("2026-07-02T00:00:00.000Z");
    row.dismissedEvidenceHash = row.evidenceHash;
    row.dismissedEffectSize = null;
    row.dismissedSampleSize = null;

    const unchanged = await syncAcceptedPatterns({
      userId: "owner-2",
      family: PATTERN_FAMILIES.moodTagCrosstab,
      accepted: [baseEvidence],
    });
    expect(unchanged.get(canonicalKey)?.dismissed).toBe(true);

    const moved = await syncAcceptedPatterns({
      userId: "owner-2",
      family: PATTERN_FAMILIES.moodTagCrosstab,
      accepted: [{ ...baseEvidence, pValue: 0.002 }],
    });
    expect(moved.get(canonicalKey)?.dismissed).toBe(false);
    expect(row.dismissedAt).toBeNull();
    expect(row.dismissedEvidenceHash).toBeNull();
  });
});
