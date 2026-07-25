"use client";

/**
 * v1.18.2 — Vorsorge (preventive-care) dashboard summary card.
 *
 * A compact chart-row card listing the next few due reminders with an
 * inline primary action per row — the same done-vs-capture branch the
 * dedicated `/checkups` page surfaces, scaled down for the dashboard.
 * A free-text / self-planned exam marks done silently; a measurement-
 * linked reminder opens the real measurement-entry form and satisfies
 * the reminder in the same action.
 *
 * Mirrors the medication compliance card's role on the chart row:
 * chart-row only, no strip tile. Self-skeletons while the read is in
 * flight and self-gates to a brief empty state otherwise.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, CheckCircle2, Plus } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { MeasurementForm } from "@/components/measurements/measurement-form";
import { isScreeningReminderType } from "@/lib/validations/measurement-reminders";
import {
  useMeasurementReminders,
  useMeasurementReminderMutations,
  type MeasurementReminder,
} from "@/hooks/use-measurement-reminders";

const DAY_MS = 24 * 60 * 60 * 1000;
const SUMMARY_LIMIT = 3;

/**
 * v1.32.36 — returns a FULLY-QUALIFIED i18n key, not a bare tail. A call site
 * that interpolates the tail onto the namespace root anchors the
 * reverse-coverage guard at that bare namespace, which marks every key under
 * it reachable and turns the guard into a no-op for the whole namespace. The
 * guard now refuses that shape outright, so the key is built whole here.
 */
function relativeDueKey(
  nextDueAt: string | null,
  now: number,
): { key: string; days: number } {
  if (!nextDueAt) return { key: "measurementReminders.nextDue.none", days: 0 };
  const deltaDays = Math.round((new Date(nextDueAt).getTime() - now) / DAY_MS);
  if (deltaDays < 0)
    return {
      key: "measurementReminders.overdueByDays",
      days: Math.abs(deltaDays),
    };
  if (deltaDays === 0)
    return { key: "measurementReminders.nextDue.today", days: 0 };
  if (deltaDays === 1)
    return { key: "measurementReminders.nextDue.tomorrow", days: 1 };
  return { key: "measurementReminders.nextDue.inDays", days: deltaDays };
}

function resolveLabel(
  reminder: MeasurementReminder,
  t: (key: string) => string,
): string {
  if (reminder.origin === "COACH") {
    const translated = t(reminder.label);
    return translated === reminder.label ? reminder.label : translated;
  }
  return reminder.label;
}

export function VorsorgeDashboardCard() {
  const { t } = useTranslations();
  const router = useRouter();
  const { data: reminders, isLoading } = useMeasurementReminders();
  const { satisfy } = useMeasurementReminderMutations();
  const [now] = useState(() => Date.now());
  const [capturing, setCapturing] = useState<MeasurementReminder | null>(null);
  const [captureFooterEl, setCaptureFooterEl] = useState<HTMLDivElement | null>(
    null,
  );

  // Active reminders only (the manage toggles hide disabled ones from the
  // summary), most-urgent first as the API already sorts them.
  const upcoming = (reminders ?? [])
    .filter((r) => r.enabled)
    .slice(0, SUMMARY_LIMIT);

  // v1.27.6 — a screening reminder routes to the check-in page (a score is
  // never typed in); completing the test auto-satisfies the reminder.
  function onPrimaryAction(reminder: MeasurementReminder) {
    if (isScreeningReminderType(reminder.measurementType)) {
      router.push("/mental-wellbeing");
    } else if (reminder.measurementType) {
      setCapturing(reminder);
    } else {
      satisfy.mutate(reminder.id);
    }
  }

  function onCaptureSuccess() {
    const reminder = capturing;
    setCapturing(null);
    if (reminder) satisfy.mutate(reminder.id);
  }

  return (
    <Card data-slot="vorsorge-dashboard-card" className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <CalendarClock className="h-4 w-4" aria-hidden="true" />
          {t("measurementReminders.sectionTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : upcoming.length === 0 ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">
              {t("measurementReminders.dashboard.empty")}
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/checkups">
                {t("measurementReminders.dashboard.openLink")}
              </Link>
            </Button>
          </div>
        ) : (
          <ul className="space-y-2">
            {upcoming.map((reminder) => {
              const due = relativeDueKey(reminder.nextDueAt, now);
              const isLinked = reminder.measurementType != null;
              const isScreening = isScreeningReminderType(
                reminder.measurementType,
              );
              return (
                <ListRow
                  key={reminder.id}
                  asChild
                  className="flex items-center justify-between gap-3"
                >
                  <li>
                    <div className="min-w-0 space-y-1">
                      <p className="truncate text-sm font-medium">
                        {resolveLabel(reminder, t)}
                      </p>
                      <Badge variant="secondary" className="text-xs">
                        {t(due.key, {
                          days: due.days,
                        })}
                      </Badge>
                    </div>
                    <Button
                      type="button"
                      size="default"
                      className="min-h-11 shrink-0 sm:min-h-9"
                      onClick={() => onPrimaryAction(reminder)}
                      disabled={satisfy.isPending}
                    >
                      {isLinked ? (
                        <>
                          <Plus className="h-4 w-4" />
                          {t(
                            isScreening
                              ? "measurementReminders.startCheckIn"
                              : "measurementReminders.captureValue",
                          )}
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="h-4 w-4" />
                          {t("measurementReminders.markDone")}
                        </>
                      )}
                    </Button>
                  </li>
                </ListRow>
              );
            })}
          </ul>
        )}
      </CardContent>

      <ResponsiveSheet
        open={capturing !== null}
        onOpenChange={(open) => {
          if (!open) setCapturing(null);
        }}
        title={t("measurementReminders.capture.title")}
        description={t("measurementReminders.capture.description")}
        footer={<div ref={setCaptureFooterEl} className="flex w-full" />}
      >
        {capturing && (
          <MeasurementForm
            defaultType={capturing.measurementType ?? undefined}
            onSuccess={onCaptureSuccess}
            onCancel={() => setCapturing(null)}
            footerSlot={captureFooterEl}
          />
        )}
      </ResponsiveSheet>
    </Card>
  );
}
