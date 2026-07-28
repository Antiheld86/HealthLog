import { createHash } from "node:crypto";

import { prisma } from "@/lib/db";

export const PATTERN_FAMILIES = {
  discoveryRetrospective: "DISCOVERY_RETROSPECTIVE",
  discoveryRecent: "DISCOVERY_RECENT",
  fixed: "FIXED",
  moodTagCrosstab: "MOOD_TAG_CROSSTAB",
  moodFactorCrosstab: "MOOD_FACTOR_CROSSTAB",
} as const;

export type PatternFamily =
  (typeof PATTERN_FAMILIES)[keyof typeof PATTERN_FAMILIES];

export interface AcceptedPatternEvidence {
  factorKey: string;
  outcomeKey: string;
  lagDays: number;
  sampleSize: number;
  effectSize: number;
  pValue: number;
  qValue?: number | null;
}

export interface PatternDecision {
  patternId: string;
  canonicalKey: string;
  dismissed: boolean;
}

/** Stable identity derived only from the user-independent pair definition. */
export function canonicalPatternKey(
  factorKey: string,
  outcomeKey: string,
  lagDays: number,
): string {
  const source = JSON.stringify([factorKey, outcomeKey, lagDays]);
  return `p1:${createHash("sha256").update(source).digest("hex")}`;
}

function evidenceHash(evidence: AcceptedPatternEvidence): string {
  const source = JSON.stringify({
    factorKey: evidence.factorKey,
    outcomeKey: evidence.outcomeKey,
    lagDays: evidence.lagDays,
    sampleSize: evidence.sampleSize,
    effectSize: evidence.effectSize,
    pValue: evidence.pValue,
    qValue: evidence.qValue ?? null,
  });
  return createHash("sha256").update(source).digest("hex");
}

/**
 * A dismissal survives normal sampling noise. It is released only when the
 * effect reverses direction, moves by at least 0.10, or the accepted sample
 * grows by at least 25% (with a ten-observation floor).
 */
export function isMaterialEvidenceChange(args: {
  currentEffectSize: number;
  currentSampleSize: number;
  dismissedEffectSize: number;
  dismissedSampleSize: number;
}): boolean {
  const signChanged =
    Math.sign(args.currentEffectSize) !== Math.sign(args.dismissedEffectSize);
  const effectMoved =
    Math.abs(args.currentEffectSize - args.dismissedEffectSize) >= 0.1;
  const sampleGrowth = Math.max(10, Math.ceil(args.dismissedSampleSize * 0.25));
  const sampleDeepened =
    args.currentSampleSize >= args.dismissedSampleSize + sampleGrowth;
  return signChanged || effectMoved || sampleDeepened;
}

/**
 * Persist one accepted family run, retire findings no longer accepted, and
 * return the server's presentation decision for every accepted finding.
 */
export async function syncAcceptedPatterns(args: {
  userId: string;
  family: PatternFamily;
  accepted: AcceptedPatternEvidence[];
  computedAt?: Date;
}): Promise<Map<string, PatternDecision>> {
  const computedAt = args.computedAt ?? new Date();
  const prepared = args.accepted.map((evidence) => ({
    evidence,
    canonicalKey: canonicalPatternKey(
      evidence.factorKey,
      evidence.outcomeKey,
      evidence.lagDays,
    ),
    evidenceHash: evidenceHash(evidence),
  }));
  const keys = prepared.map((item) => item.canonicalKey);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.correlationPattern.findMany({
      where: { userId: args.userId, canonicalKey: { in: keys } },
    });
    const existingByKey = new Map(
      existing.map((row) => [row.canonicalKey, row]),
    );

    if (keys.length === 0) {
      await tx.correlationPattern.updateMany({
        where: { userId: args.userId, family: args.family, isCurrent: true },
        data: { isCurrent: false },
      });
    } else {
      await tx.correlationPattern.updateMany({
        where: {
          userId: args.userId,
          family: args.family,
          isCurrent: true,
          canonicalKey: { notIn: keys },
        },
        data: { isCurrent: false },
      });
    }

    const decisions = new Map<string, PatternDecision>();
    for (const item of prepared) {
      const prior = existingByKey.get(item.canonicalKey);
      const shouldResurface =
        prior?.dismissedAt != null &&
        prior.dismissedEffectSize != null &&
        prior.dismissedSampleSize != null &&
        isMaterialEvidenceChange({
          currentEffectSize: item.evidence.effectSize,
          currentSampleSize: item.evidence.sampleSize,
          dismissedEffectSize: prior.dismissedEffectSize,
          dismissedSampleSize: prior.dismissedSampleSize,
        });

      const row = await tx.correlationPattern.upsert({
        where: {
          userId_canonicalKey: {
            userId: args.userId,
            canonicalKey: item.canonicalKey,
          },
        },
        create: {
          userId: args.userId,
          canonicalKey: item.canonicalKey,
          family: args.family,
          factorKey: item.evidence.factorKey,
          outcomeKey: item.evidence.outcomeKey,
          lagDays: item.evidence.lagDays,
          sampleSize: item.evidence.sampleSize,
          effectSize: item.evidence.effectSize,
          pValue: item.evidence.pValue,
          qValue: item.evidence.qValue ?? null,
          evidenceHash: item.evidenceHash,
          isCurrent: true,
          lastComputedAt: computedAt,
        },
        update: {
          family: args.family,
          factorKey: item.evidence.factorKey,
          outcomeKey: item.evidence.outcomeKey,
          lagDays: item.evidence.lagDays,
          sampleSize: item.evidence.sampleSize,
          effectSize: item.evidence.effectSize,
          pValue: item.evidence.pValue,
          qValue: item.evidence.qValue ?? null,
          evidenceHash: item.evidenceHash,
          isCurrent: true,
          lastComputedAt: computedAt,
          ...(shouldResurface
            ? {
                dismissedAt: null,
                dismissedEvidenceHash: null,
                dismissedEffectSize: null,
                dismissedSampleSize: null,
              }
            : {}),
        },
      });

      decisions.set(item.canonicalKey, {
        patternId: row.id,
        canonicalKey: row.canonicalKey,
        dismissed: row.dismissedAt != null,
      });
    }
    return decisions;
  });
}

export function decisionForEvidence(
  decisions: Map<string, PatternDecision>,
  evidence: Pick<
    AcceptedPatternEvidence,
    "factorKey" | "outcomeKey" | "lagDays"
  >,
): PatternDecision | null {
  return (
    decisions.get(
      canonicalPatternKey(
        evidence.factorKey,
        evidence.outcomeKey,
        evidence.lagDays,
      ),
    ) ?? null
  );
}
