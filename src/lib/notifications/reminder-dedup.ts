/**
 * Reminder dedup anchor — "this slot already went out today".
 *
 * The medication-reminder tick runs every 15 minutes and re-derives the
 * same overdue slot on every pass, so it needs a durable record of what it
 * already sent. That record used to be the Telegram message ledger, which
 * only exists when a Telegram send succeeded: a user on email, APNs or
 * ntfy had no row, so the tick re-sent the same overdue notice on every
 * pass for the rest of the local day.
 *
 * The anchor now lives in `push_attempts`, the ledger the daily briefing
 * and the illness escalation already use for the same purpose. Two
 * properties matter and both are deliberate:
 *
 *  - **Written per dispatched slot, not per successful send.** Anchoring
 *    on a delivered push would re-open the flood the moment a channel
 *    starts failing, which is the original defect wearing a new key.
 *  - **Written before the dispatch.** A crash mid-dispatch burns the slot
 *    for that phase rather than risking a repeat; the next phase still
 *    escalates, and the next local day starts clean.
 *
 * The rows are bookkeeping, not delivery attempts, so they carry the
 * `DEDUP` channel sentinel and the operator-facing notification surfaces
 * filter them out.
 */
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Channel sentinel for a bookkeeping row. Never a real delivery target —
 * `/api/admin/notifications/{health,diagnostic}` exclude it so the
 * per-channel health picture stays a picture of actual sends.
 */
export const REMINDER_DEDUP_CHANNEL = "DEDUP";

/**
 * How far back the anchor lookup reads. The key already carries the local
 * date, so anything older than this cannot match; the bound exists to keep
 * the read on the `(user_id, created_at DESC)` index. Two days covers every
 * timezone offset plus a DST shift.
 */
const ANCHOR_LOOKBACK_MS = 48 * 60 * 60 * 1000;

/**
 * Dedup key for one medication dose slot in one phase on one local day.
 *
 * `scheduleId` and the slot's real `HH:mm` are BOTH in the key. Dropping
 * either one silently merges slots that must stay separate: two legacy
 * single-window schedules on the same medication share the empty
 * first-class time-of-day, and two schedules can name the same time with
 * different doses. Over-suppression is the failure mode this whole change
 * risks introducing, so the key stays at least as fine as the ledger it
 * replaces.
 */
export function medicationReminderDedupKey(input: {
  medicationId: string;
  scheduleId: string;
  slotTime: string;
  phase: string;
  localDate: string;
}): string {
  return [
    "med",
    input.medicationId,
    input.scheduleId,
    input.slotTime,
    input.phase,
    input.localDate,
  ].join(":");
}

/**
 * Has this exact slot+phase+day already been dispatched? Best-effort: a DB
 * error biases toward "not yet", so a transient blip delays nothing — the
 * cost of a rare duplicate is far below the cost of a silently dropped
 * dose reminder.
 */
export async function hasReminderDedupAnchor(
  prisma: PrismaClient,
  input: { userId: string; eventType: string; reason: string; now: Date },
): Promise<boolean> {
  try {
    const row = await prisma.pushAttempt.findFirst({
      where: {
        userId: input.userId,
        eventType: input.eventType,
        reason: input.reason,
        createdAt: { gte: new Date(input.now.getTime() - ANCHOR_LOOKBACK_MS) },
      },
      select: { id: true },
    });
    return row !== null;
  } catch {
    return false;
  }
}

/**
 * Stamp the anchor. Never throws — a failed stamp costs a duplicate
 * notification at the next tick, while a thrown error would cost the
 * dispatch itself.
 */
export async function writeReminderDedupAnchor(
  prisma: PrismaClient,
  input: { userId: string; eventType: string; reason: string },
): Promise<void> {
  try {
    await prisma.pushAttempt.create({
      data: {
        userId: input.userId,
        channel: REMINDER_DEDUP_CHANNEL,
        eventType: input.eventType,
        result: "skipped",
        reason: input.reason,
      },
    });
  } catch {
    // Best-effort by contract; the next tick re-derives the same slot.
  }
}
