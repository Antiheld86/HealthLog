"use client";

/**
 * v1.18.6 (W8 / MOD-03) — the Vorsorge module's own settings page body.
 *
 * Reached from the wrench beside the page's "hinzufügen" button. Lets the
 * user reorder reminders + pick the card-vs-list page view, and re-homes the
 * per-reminder enable/disable toggles that used to live in the page's
 * "Anpassen" sheet. Order + view persist client-side via
 * `useModuleListPrefs("vorsorge")`; the toggles persist through the existing
 * reminder PATCH route.
 */
import { ArrowUpDown, LayoutGrid, ListChecks } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ModuleViewToggle } from "@/components/module-list/module-view-toggle";
import {
  ModuleOrderEditor,
  type ReorderItem,
} from "@/components/module-list/module-order-editor";
import { applyOrder, useModuleListPrefs } from "@/lib/module-list-prefs";
import {
  useMeasurementReminders,
  useMeasurementReminderMutations,
  type MeasurementReminder,
} from "@/hooks/use-measurement-reminders";

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

export function VorsorgeSettings() {
  const { t } = useTranslations();
  const { data: reminders, isLoading } = useMeasurementReminders(true);
  const { update } = useMeasurementReminderMutations();
  const { prefs, setView, setOrder } = useModuleListPrefs("vorsorge");

  const ordered = applyOrder(reminders ?? [], prefs.order, (r) => r.id);
  const reorderItems: ReorderItem[] = ordered.map((r) => ({
    id: r.id,
    name: resolveLabel(r, t),
    secondary: r.measurementType
      ? t(`measurementReminders.types.${r.measurementType}`)
      : t("measurementReminders.selfPlanned"),
  }));

  // v1.18.10 (W7) — the three Vorsorge settings groups adopt the shared
  // `SettingsCard` + `SettingsCardHeader` contract (rounded-xl bordered
  // surface, neutral muted icon, `text-lg` title, short muted description)
  // so this surface reads like every other Settings section instead of bare
  // `<section>` blocks with `text-sm` headings.
  return (
    <div className="space-y-6">
      {/* v1.25.3 — `id="vorsorge-view"` + `scroll-mt-28` so the Appearance hub
          deep-link (`/settings/vorsorge#vorsorge-view`) lands on this card
          below the sticky page header, mirroring the labs/illness anchors. */}
      <SettingsCard id="vorsorge-view" className="scroll-mt-28">
        <SettingsCardHeader
          icon={LayoutGrid}
          title={t("moduleList.viewHeading")}
          description={t("moduleList.viewDescription")}
          status={<ModuleViewToggle view={prefs.view} onChange={setView} />}
        />
      </SettingsCard>

      <SettingsCard>
        <SettingsCardHeader
          icon={ArrowUpDown}
          title={t("moduleList.reorder.heading")}
          description={t("moduleList.reorder.description")}
        />
        <div>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <ModuleOrderEditor items={reorderItems} onChange={setOrder} />
          )}
        </div>
      </SettingsCard>

      <SettingsCard>
        <SettingsCardHeader
          icon={ListChecks}
          title={t("measurementReminders.manage.title")}
          description={t("measurementReminders.manage.description")}
        />
        <div>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (reminders?.length ?? 0) === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("measurementReminders.manage.empty")}
            </p>
          ) : (
            <Card>
              <CardContent className="divide-border divide-y p-0">
                {ordered.map((reminder) => (
                  <div
                    key={reminder.id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <span
                      id={`vorsorge-reminder-label-${reminder.id}`}
                      className="min-w-0 truncate text-sm"
                    >
                      {resolveLabel(reminder, t)}
                    </span>
                    <Switch
                      checked={reminder.enabled}
                      onCheckedChange={(next) =>
                        update.mutate({
                          id: reminder.id,
                          body: { enabled: next },
                        })
                      }
                      disabled={update.isPending}
                      // L3 — label each row's Switch by its own name span so SR
                      // users hear the reminder name (plus the switch role's
                      // on/off state) instead of N identical generic labels.
                      aria-labelledby={`vorsorge-reminder-label-${reminder.id}`}
                    />
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
