import { apiSuccess } from "@/lib/api-response";
import { getReminderThresholds } from "@/lib/app-settings";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { parseNotificationPrefs } from "@/lib/validations/notification-prefs";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  // The RECORD's thresholds, and the third of the presentation trio — but the
  // one where "presentation" understates it. These two numbers decide whether
  // a medication card reads "low stock" and when it says to reorder, and the
  // cards they colour are the OWNER's. Answering with the caller's runway
  // would put the delegate's idea of "running out" on somebody else's supply:
  // a helper who keeps a fortnight's buffer would see a warning on a cabinet
  // its owner considers comfortable, or worse, miss one on a cabinet its owner
  // does not.
  //
  // What this route projects out of `notificationPrefs` is exactly two
  // integers. That object also holds channels, endpoints and quiet hours, and
  // none of it is reachable from here — the two fields are named individually
  // below, and the route that serves the object whole stays refused.
  //
  // No write arm exists, so there is nothing to split: a delegate cannot move
  // the owner's threshold, only read the one the owner set.
  const { user } = await requireRecordAuth("read", "medications");

  // Operator-level singleton (`lateMinutes` / `missedMinutes`) — the same for
  // every account on the deployment, so the switch does not touch it.
  const thresholds = await getReminderThresholds();

  // v1.16.11 — the low-stock runway threshold rides along so every
  // threshold consumer reads one endpoint. Unlike `lateMinutes` /
  // `missedMinutes` (operator-level singleton) this one is PER-USER:
  // it lives in `notificationPrefs.medication.lowStockRunwayDays`
  // (1–60 days, `null` = alert off, default 7) and is written through
  // the established `PATCH /api/auth/me/notification-prefs` path.
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { notificationPrefs: true },
  });
  const prefs = parseNotificationPrefs(row?.notificationPrefs ?? null);
  const lowStockRunwayDays = prefs.medication.lowStockRunwayDays;
  // v1.17.0 — the user-level reorder lead default rides along so the
  // medication cards can derive the same reorder-lead-aware trigger the
  // daily cron uses (per-medication overrides come from the list payload's
  // own `reorderLeadDays`).
  const reorderLeadDays = prefs.medication.reorderLeadDays;

  annotate({ action: { name: "settings.reminder-thresholds.get" } });

  return apiSuccess({ ...thresholds, lowStockRunwayDays, reorderLeadDays });
});
