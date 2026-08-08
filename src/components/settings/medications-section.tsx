"use client";

import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, Loader2, Pill } from "lucide-react";

import {
  MedicationOrderEditor,
  type ReorderMedication,
} from "@/components/medications/medication-order-editor";
import { MedicationViewToggle } from "@/components/medications/medication-view-toggle";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { InjectionSitesCard } from "@/components/settings/injection-sites-card";
import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { applyMedicationOrder } from "@/lib/medications/medication-order";
import { queryKeys } from "@/lib/query-keys";
import { useMedicationListLayout } from "@/lib/queries/use-medication-list-layout";

/**
 * v1.16.10 — the "Medikamente" settings section. v1.18.0 (S5) promoted it
 * from a Layout-hub child to its own standalone nav entry and gathered the
 * medication-specific preferences here. v1.18.1 (D3) made medications a
 * toggleable fail-open module, so this nav entry hides when the account
 * turns the module off (the medication data routes stay live). Hosts three
 * blocks:
 *   1. The list VIEW preference — cards vs table, written optimistically
 *      through the same `PUT /api/medications/layout` the page header
 *      toggle uses (the toggle component is shared).
 *   2. The manual ORDER editor — two grouped lists (Aktiv / Inaktiv)
 *      with drag + arrow reordering, flushed by an explicit Save,
 *      persisted as active-ids-then-inactive-ids on the same layout row.
 *   3. Injection-site exclusions — moved here from the account profile so
 *      every medication-specific preference lives on one screen.
 *
 * The list view + order both write through the same `/api/medications/layout`
 * contract the /medications page reads, so a save here repaints both views.
 */

/** The slice of the medications list the order editor needs. */
interface MedicationListEntry {
  id: string;
  name: string;
  dose: string;
  active: boolean;
}

export function MedicationsSection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const { layout, isLayoutLoading, setView } = useMedicationListLayout();

  const { data: medications, isLoading } = useQuery({
    queryKey: queryKeys.medications(),
    queryFn: async () => {
      return apiGet<MedicationListEntry[]>("/api/medications");
    },
  });

  // Defensive against stale service-worker responses or any future API
  // shape change: only map when we actually have an array. The editor
  // receives the page's current effective order (active block first,
  // inactive after) so it opens showing exactly what both views render.
  const medsArray = Array.isArray(medications) ? medications : [];
  const ordered: ReorderMedication[] = [
    ...applyMedicationOrder(
      medsArray.filter((m) => m.active),
      layout.order,
    ),
    ...applyMedicationOrder(
      medsArray.filter((m) => !m.active),
      layout.order,
    ),
  ].map((m) => ({ id: m.id, name: m.name, dose: m.dose, active: m.active }));

  // v1.18.6 (W9) — the visible heading + subtitle now come from the shared
  // `<SettingsSectionFrame>` in the route; this body is the medication cards.
  return (
    <div className="space-y-6">
      {/* View preference — cards vs table. The shared header toggle
          writes optimistically, so there is no Save button here. */}
      <SettingsCard id="medications-view" className="scroll-mt-28">
        <SettingsCardHeader
          icon={LayoutGrid}
          title={t("medications.viewToggleLabel")}
        />
        <div className="border-border bg-background/30 flex min-h-12 items-center justify-between gap-3 rounded-md border px-3 py-2">
          <p className="text-muted-foreground min-w-0 text-xs">
            {t("medications.viewToggleHint")}
          </p>
          {isLayoutLoading ? (
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <MedicationViewToggle view={layout.view} onChange={setView} />
          )}
        </div>
      </SettingsCard>

      {/* Manual order — applies to both list views. */}
      <SettingsCard id="medications-order" className="scroll-mt-28">
        <SettingsCardHeader
          icon={Pill}
          title={t("medications.reorderTitle")}
          description={t("medications.reorderDescription")}
        />
        {isLoading || isLayoutLoading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            {t("common.loading")}
          </div>
        ) : (
          <MedicationOrderEditor medications={ordered} />
        )}
      </SettingsCard>

      {/* v1.18.0 (S5) — injection-site exclusions are a medication setting;
          they moved here from the account profile so all medication-specific
          preferences live in one place. */}
      <InjectionSitesCard isAuthenticated={isAuthenticated} />
    </div>
  );
}
