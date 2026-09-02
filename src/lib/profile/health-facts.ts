import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { invalidateUserInsights } from "@/lib/cache/invalidate";
import { getEvent } from "@/lib/logging/context";
import {
  HEALTH_PROFILE_FACT_KINDS,
  isHealthProfileFactValue,
  type HealthProfileFactKind,
  type HealthProfileFactValue,
} from "@/lib/validations/health-profile-facts";

export interface HealthProfileFactRevisionDto {
  id: string;
  kind: HealthProfileFactKind;
  value: HealthProfileFactValue | null;
  unreadable: boolean;
  validFrom: string;
  validUntil: string | null;
  provenance: "USER_REPORTED" | "USER_CORRECTION";
  supersededByRevisionId: string | null;
  createdAt: string;
}

interface FactRevisionRow {
  id: string;
  kind: HealthProfileFactKind;
  valueEncrypted: Uint8Array;
  validFrom: Date;
  validUntil: Date | null;
  provenance: "USER_REPORTED" | "USER_CORRECTION";
  supersededByRevisionId: string | null;
  createdAt: Date;
}

export interface HealthProfileFactsPayload {
  current: Record<HealthProfileFactKind, HealthProfileFactRevisionDto | null>;
  history: HealthProfileFactRevisionDto[];
}

export interface RemovedHealthProfileFactDto {
  id: string;
  kind: HealthProfileFactKind;
  removedAt: string;
}

/**
 * Clear every cache that can render AI text derived from profile facts.
 * The persisted cache clear also advances User.updatedAt, which is the scope
 * version checked by in-flight insight generation before it can commit.
 */
export async function invalidateHealthProfileFactConsumers(
  userId: string,
  tx: Pick<Prisma.TransactionClient, "user">,
): Promise<void> {
  await tx.user.update({
    where: { id: userId },
    data: {
      insightsCachedAt: null,
      insightsCachedText: null,
      insightsCachedLocale: null,
    },
  });
  invalidateUserInsights(userId);
}

export function decryptHealthProfileFactValue(
  kind: HealthProfileFactKind,
  payload: Uint8Array,
): { value: HealthProfileFactValue | null; unreadable: boolean } {
  try {
    const raw = decryptFromBytes(payload).trim();
    if (isHealthProfileFactValue(kind, raw)) {
      return { value: raw, unreadable: false };
    }
    getEvent()?.addWarning(`health profile fact has an invalid ${kind} value`);
  } catch (error) {
    getEvent()?.addWarning(
      `health profile fact decrypt failed (${kind}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { value: null, unreadable: true };
}

export function toHealthProfileFactDto(
  row: FactRevisionRow,
): HealthProfileFactRevisionDto {
  const decrypted = decryptHealthProfileFactValue(row.kind, row.valueEncrypted);
  return {
    id: row.id,
    kind: row.kind,
    value: decrypted.value,
    unreadable: decrypted.unreadable,
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil?.toISOString() ?? null,
    provenance: row.provenance,
    supersededByRevisionId: row.supersededByRevisionId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function readHealthProfileFacts(
  userId: string,
): Promise<HealthProfileFactsPayload> {
  const rows = (await prisma.healthProfileFactRevision.findMany({
    where: { userId },
    orderBy: [{ kind: "asc" }, { validFrom: "desc" }],
    select: {
      id: true,
      kind: true,
      valueEncrypted: true,
      validFrom: true,
      validUntil: true,
      provenance: true,
      supersededByRevisionId: true,
      createdAt: true,
    },
  })) as FactRevisionRow[];

  const history = rows.map(toHealthProfileFactDto);
  const current = Object.fromEntries(
    HEALTH_PROFILE_FACT_KINDS.map((kind) => [
      kind,
      history.find(
        (row) =>
          row.kind === kind &&
          row.validUntil === null &&
          row.supersededByRevisionId === null,
      ) ?? null,
    ]),
  ) as Record<HealthProfileFactKind, HealthProfileFactRevisionDto | null>;

  return { current, history };
}

export async function createHealthProfileFact(
  userId: string,
  kind: HealthProfileFactKind,
  value: HealthProfileFactValue,
  now: Date = new Date(),
): Promise<HealthProfileFactRevisionDto> {
  return prisma.$transaction(async (tx) => {
    const row = (await tx.healthProfileFactRevision.create({
      data: {
        userId,
        kind,
        valueEncrypted: encryptToBytes(value),
        validFrom: now,
        provenance: "USER_REPORTED",
      },
      select: {
        id: true,
        kind: true,
        valueEncrypted: true,
        validFrom: true,
        validUntil: true,
        provenance: true,
        supersededByRevisionId: true,
        createdAt: true,
      },
    })) as FactRevisionRow;
    await invalidateHealthProfileFactConsumers(userId, tx);
    return toHealthProfileFactDto(row);
  });
}

export async function correctHealthProfileFact(
  userId: string,
  revisionId: string,
  value: HealthProfileFactValue,
  now: Date = new Date(),
): Promise<HealthProfileFactRevisionDto | null> {
  return prisma.$transaction(async (tx) => {
    const current = (await tx.healthProfileFactRevision.findFirst({
      where: {
        id: revisionId,
        userId,
        validUntil: null,
        supersededByRevisionId: null,
      },
      select: {
        id: true,
        kind: true,
        valueEncrypted: true,
        validFrom: true,
        validUntil: true,
        provenance: true,
        supersededByRevisionId: true,
        createdAt: true,
      },
    })) as FactRevisionRow | null;
    if (!current) return null;

    const effectiveAt = new Date(
      Math.max(now.getTime(), current.validFrom.getTime() + 1),
    );
    const successorId = randomUUID();
    const closed = await tx.healthProfileFactRevision.updateMany({
      where: {
        id: current.id,
        userId,
        validUntil: null,
        supersededByRevisionId: null,
      },
      data: { validUntil: effectiveAt },
    });
    if (closed.count !== 1) return null;

    const successor = (await tx.healthProfileFactRevision.create({
      data: {
        id: successorId,
        userId,
        kind: current.kind,
        valueEncrypted: encryptToBytes(value),
        validFrom: effectiveAt,
        provenance: "USER_CORRECTION",
      },
      select: {
        id: true,
        kind: true,
        valueEncrypted: true,
        validFrom: true,
        validUntil: true,
        provenance: true,
        supersededByRevisionId: true,
        createdAt: true,
      },
    })) as FactRevisionRow;

    await tx.healthProfileFactRevision.update({
      where: { id: current.id },
      data: { supersededByRevisionId: successor.id },
    });
    await invalidateHealthProfileFactConsumers(userId, tx);

    return toHealthProfileFactDto(successor);
  });
}

/**
 * Close the current effective interval without deleting or superseding its
 * revision. The closed row remains in dated history, while every current-value
 * consumer excludes it through `validUntil: null`. The revision id is the
 * optimistic token, and the guarded update prevents a stale request from
 * closing a successor.
 */
export async function removeHealthProfileFact(
  userId: string,
  revisionId: string,
  now: Date = new Date(),
): Promise<RemovedHealthProfileFactDto | null> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.healthProfileFactRevision.findFirst({
      where: {
        id: revisionId,
        userId,
        validUntil: null,
        supersededByRevisionId: null,
      },
      select: { id: true, kind: true, validFrom: true },
    });
    if (!current) return null;

    const effectiveAt = new Date(
      Math.max(now.getTime(), current.validFrom.getTime() + 1),
    );
    const closed = await tx.healthProfileFactRevision.updateMany({
      where: {
        id: current.id,
        userId,
        validUntil: null,
        supersededByRevisionId: null,
      },
      data: { validUntil: effectiveAt },
    });
    if (closed.count !== 1) return null;
    await invalidateHealthProfileFactConsumers(userId, tx);

    return {
      id: current.id,
      kind: current.kind as HealthProfileFactKind,
      removedAt: effectiveAt.toISOString(),
    };
  });
}
