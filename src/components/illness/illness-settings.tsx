"use client";

/**
 * v1.18.6 (W8 / MOD-03) — the Illness module's own settings page body.
 *
 * Reached from the wrench beside the page's "hinzufügen" button. Lets the
 * user reorder conditions/episodes + pick the card-vs-list page view. Order
 * + view persist client-side via `useModuleListPrefs("illness")`.
 *
 * v1.18.9 — restructured onto the canonical Settings pattern: each block is a
 * `<SettingsCard>` with a `<SettingsCardHeader>` (neutral icon + `text-lg`
 * title + a short muted description), matching the Stimmung / Medikamente
 * sections rather than the bespoke bare-`<section>` headings it carried
 * before.
 */
import { Eye, ListOrdered } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { ModuleViewToggle } from "@/components/module-list/module-view-toggle";
import {
  ModuleOrderEditor,
  type ReorderItem,
} from "@/components/module-list/module-order-editor";
import { applyOrder, useModuleListPrefs } from "@/lib/module-list-prefs";
import { useIllnessEpisodes } from "./use-illness";

export function IllnessSettings() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { data: episodes, isLoading } = useIllnessEpisodes(true);
  const { prefs, setView, setOrder } = useModuleListPrefs("illness");

  const ordered = applyOrder(episodes ?? [], prefs.order, (e) => e.id);
  const reorderItems: ReorderItem[] = ordered.map((e) => ({
    id: e.id,
    name: e.label,
    secondary: `${t(`illness.type.${e.type}`)} · ${
      e.resolvedAt
        ? t("illness.status.recovered")
        : e.lifecycle === "CHRONIC_ONGOING"
          ? t("illness.status.ongoing")
          : t("illness.status.active")
    } · ${fmt.dateShortSmart(new Date(e.onsetAt))}`,
  }));

  return (
    <div className="space-y-6">
      <SettingsCard id="illness-view" className="scroll-mt-28">
        <SettingsCardHeader
          icon={Eye}
          title={t("moduleList.viewHeading")}
          description={t("illness.settings.viewDescription")}
          status={<ModuleViewToggle view={prefs.view} onChange={setView} />}
        />
      </SettingsCard>

      <SettingsCard id="illness-order" className="scroll-mt-28">
        <SettingsCardHeader
          icon={ListOrdered}
          title={t("moduleList.reorder.heading")}
          description={t("illness.settings.orderDescription")}
        />
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <ModuleOrderEditor items={reorderItems} onChange={setOrder} />
        )}
      </SettingsCard>
    </div>
  );
}
