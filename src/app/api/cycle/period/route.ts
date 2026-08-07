/**
 * `POST /api/cycle/period` — one-tap period-boundary shortcut
 * (ios-contract §2.C).
 *
 * `action:"start"` opens a new `MenstrualCycle` anchored at `date`,
 * closes the prior open cycle (endDate = day before, lengthDays set),
 * and writes the boundary `CycleDayLog(flow=MEDIUM)`. `action:"end"`
 * stamps the current cycle's `periodEndDate` and writes the boundary
 * day-log. Convenience over §2.A; returns
 * `{ cycle: MenstrualCycleDTO, dayLog: CycleDayLogDTO }`.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import {
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { withIdempotency } from "@/lib/idempotency";
import { cyclePeriodSchema } from "@/lib/validations/cycle";
import {
  unstableExternalIdMeta,
  unstableExternalIdShape,
} from "@/lib/validations/external-id";
import { upsertCycleDayLog } from "@/lib/cycle/day-log-write";
import type { FlowLevel } from "@/lib/cycle/types";
import {
  toCycleDayLogDTO,
  toMenstrualCycleDTO,
  dayLogSymptomInclude,
} from "@/lib/cycle/dto";
import { DEFAULT_TIMEZONE } from "@/lib/mood/date-key";
import { addDays, dayDiff } from "@/lib/cycle/day-math";

export const POST = apiHandler(withIdempotency<[NextRequest]>(postPeriod));

/**
 * v1.37.0 — the anchors a boundary write moves, carried out of the
 * transaction so the audit row can name them (C4).
 */
interface MovedAnchors {
  priorCycleId?: string;
  /** Day keys, the shape this domain stores its dates in. */
  priorEndDateBefore?: string | null;
  priorEndDateAfter?: string | null;
  priorLengthBefore?: number | null;
  priorLengthAfter?: number | null;
  openedEndDateBefore?: string | null;
  openedEndDateAfter?: string | null;
  periodEndDateBefore?: string | null;
  periodEndDateAfter?: string | null;
}

async function postPeriod(request: NextRequest): Promise<Response> {
  // v1.37.0 — MANAGE. Setting a boundary re-anchors the neighbouring cycles,
  // which is the destructive part of it: a handful of dates move and nothing
  // else records what they were. The audit row below carries them (C4).
  const { user } = await requireRecordAuth("manage", "cycle");

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = cyclePeriodSchema.safeParse(rawBody);
  if (!parsed.success) {
    const shape = unstableExternalIdShape(rawBody);
    annotate({
      action: { name: "cycle.period.validation-failed" },
      meta: {
        issue_count: parsed.error.issues.length,
        ...(shape ? unstableExternalIdMeta("cycle.period", [shape]) : {}),
      },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "cycle.period.invalid",
    });
  }

  const { action, date, externalId, loggedAt } = parsed.data;
  const tz = user.timezone ?? DEFAULT_TIMEZONE;

  // The close-prior + open-new (start) or stamp-current (end) mutation set
  // is run inside a single transaction so two concurrent taps can never
  // double-close a prior cycle or compute the new cycle's length against a
  // stale read. `withIdempotency` on the route additionally collapses an
  // exact-key replay; the transaction guards the interleaving case.
  const txResult = await prisma.$transaction(async (db) => {
    if (action === "start") {
      // Close the prior open cycle (its end is the day before this start)
      // and record its observed length.
      const prior = await db.menstrualCycle.findFirst({
        where: { userId: user.id, deletedAt: null, startDate: { lt: date } },
        orderBy: { startDate: "desc" },
        // v1.37.0 — `endDate` and `lengthDays` are read for the audit row:
        // this write overwrites both on the prior cycle and they are the
        // dates C4 exists to name.
        select: {
          id: true,
          startDate: true,
          endDate: true,
          lengthDays: true,
        },
      });
      const moved: MovedAnchors = {};
      if (prior) {
        moved.priorCycleId = prior.id;
        moved.priorEndDateBefore = prior.endDate;
        moved.priorEndDateAfter = addDays(date, -1);
        moved.priorLengthBefore = prior.lengthDays;
        moved.priorLengthAfter = dayDiff(date, prior.startDate);
        await db.menstrualCycle.update({
          where: { id: prior.id },
          data: {
            endDate: addDays(date, -1),
            lengthDays: dayDiff(date, prior.startDate),
            syncVersion: { increment: 1 },
          },
        });
      }

      // Upsert the new cycle on the `(userId, startDate)` unique so a
      // re-tap on the same day is idempotent.
      const cycle = await db.menstrualCycle.upsert({
        where: { userId_startDate: { userId: user.id, startDate: date } },
        create: { userId: user.id, startDate: date, tz, isPredicted: false },
        update: {
          deletedAt: null,
          isPredicted: false,
          syncVersion: { increment: 1 },
        },
      });

      // Re-anchor the FOLLOWING neighbour: when this start is back-filled
      // between two existing cycles, the new cycle's end + length are already
      // known from its successor's start. Without this the inserted cycle keeps
      // endDate/lengthDays = null even though the next start exists, and the
      // iOS mirror + history surfaces read a stale open cycle (QA M-1).
      const next = await db.menstrualCycle.findFirst({
        where: { userId: user.id, deletedAt: null, startDate: { gt: date } },
        orderBy: { startDate: "asc" },
        select: { startDate: true },
      });
      if (next) {
        moved.openedEndDateBefore = cycle.endDate;
        moved.openedEndDateAfter = addDays(next.startDate, -1);
        await db.menstrualCycle.update({
          where: { id: cycle.id },
          data: {
            endDate: addDays(next.startDate, -1),
            lengthDays: dayDiff(next.startDate, date),
            syncVersion: { increment: 1 },
          },
        });
      }
      return { cycleId: cycle.id as string | null, moved };
    }

    // `end`: stamp the current cycle's periodEndDate.
    const current = await db.menstrualCycle.findFirst({
      where: { userId: user.id, deletedAt: null, startDate: { lte: date } },
      orderBy: { startDate: "desc" },
      // v1.37.0 — `periodEndDate` for the audit row: this arm overwrites it.
      select: { id: true, periodEndDate: true },
    });
    if (!current) {
      return { cycleId: null, moved: {} satisfies MovedAnchors };
    }
    await db.menstrualCycle.update({
      where: { id: current.id },
      data: { periodEndDate: date, syncVersion: { increment: 1 } },
    });
    return {
      cycleId: current.id as string | null,
      moved: {
        periodEndDateBefore: current.periodEndDate,
        periodEndDateAfter: date,
      } satisfies MovedAnchors,
    };
  });

  if (txResult.cycleId === null) {
    return apiSuccessNoCycle();
  }
  const cycleId: string = txResult.cycleId;

  // Boundary flow. Start → MEDIUM opens the bleed; end → SPOTTING tail.
  // Never downgrade a richer flow already logged for the same day (e.g. a
  // manual HEAVY entry must survive a later one-tap "start") — only set the
  // boundary flow when it ranks at or above what's stored.
  const boundaryFlow: FlowLevel = action === "start" ? "MEDIUM" : "SPOTTING";
  const existingDay = await prisma.cycleDayLog.findFirst({
    where: { userId: user.id, date, deletedAt: null },
    select: { flow: true },
  });
  const flow =
    flowRank(boundaryFlow) >= flowRank(existingDay?.flow ?? null)
      ? boundaryFlow
      : undefined;

  await upsertCycleDayLog(
    user.id,
    {
      date,
      ...(flow !== undefined ? { flow } : {}),
      loggedAt,
      source: "MANUAL",
      ...(externalId ? { externalId } : {}),
    },
    tz,
    cycleId,
  );

  const [cycleRow, dayLogRow] = await Promise.all([
    prisma.menstrualCycle.findUniqueOrThrow({ where: { id: cycleId } }),
    prisma.cycleDayLog.findFirstOrThrow({
      where: { userId: user.id, date, deletedAt: null },
      include: dayLogSymptomInclude,
    }),
  ]);

  await auditLog("cycle.period.boundary", {
    userId: user.id,
    ipAddress: getClientIp(request),
    // C4 — the dates this boundary moved on the neighbouring cycles. They are
    // the only unrecoverable part of the write: the day log it upserts is a
    // row, the re-anchoring is an overwrite of two columns on somebody else's
    // cycle history.
    details: {
      action,
      date,
      cycleId,
      ...(txResult.moved.priorCycleId
        ? { priorCycleId: txResult.moved.priorCycleId }
        : {}),
      ...overwriteDetails({
        before: {
          priorEndDate: txResult.moved.priorEndDateBefore,
          priorLengthDays: txResult.moved.priorLengthBefore,
          openedEndDate: txResult.moved.openedEndDateBefore,
          periodEndDate: txResult.moved.periodEndDateBefore,
        },
        after: {
          priorEndDate: txResult.moved.priorEndDateAfter,
          priorLengthDays: txResult.moved.priorLengthAfter,
          openedEndDate: txResult.moved.openedEndDateAfter,
          periodEndDate: txResult.moved.periodEndDateAfter,
        },
      }),
    },
  });

  annotate({
    action: {
      name: "cycle.period.boundary",
      entity_type: "menstrual_cycle",
      entity_id: cycleId,
    },
    meta: { boundary: action },
  });

  return apiSuccess({
    cycle: toMenstrualCycleDTO(cycleRow),
    dayLog: toCycleDayLogDTO(dayLogRow),
  });
}

/** `end` with no preceding cycle is a no-op the client should not hit. */
function apiSuccessNoCycle(): Response {
  return apiSuccess({ cycle: null, dayLog: null });
}

/**
 * Ordinal rank of a flow level (NONE = 0 … HEAVY = 5; a missing flow ranks
 * below NONE). Used to keep the one-tap boundary flow from downgrading a
 * richer same-day entry.
 */
function flowRank(flow: FlowLevel | string | null): number {
  switch (flow) {
    case "NONE":
      return 1;
    case "SPOTTING":
      return 2;
    case "LIGHT":
      return 3;
    case "MEDIUM":
      return 4;
    case "HEAVY":
      return 5;
    default:
      return 0;
  }
}
