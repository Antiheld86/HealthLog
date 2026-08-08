"use client";

/**
 * v1.38.0 — the immunization log surface.
 *
 * A calm, retrospective transcription of a lifetime Impfpass. The list groups
 * doses by their component antigen and shows where each series stands, with the
 * numbers resolved server-side (`src/lib/vaccinations/series.ts`) so this
 * client never re-derives "N von M". Neutral cards, status through a discreet
 * badge only — no red card, no overdue tint. It reproduces the record; it does
 * not adjudicate what is due.
 */
import { useState } from "react";
import { Plus, Syringe } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";

import { VaccinationList } from "./vaccination-list";
import { VaccinationSheet } from "./vaccination-sheet";
import { useVaccinations, type Vaccination } from "./use-vaccinations";

export function VaccinationsView() {
  const { t } = useTranslations();
  const { data, isLoading, isError, refetch } = useVaccinations();
  const records = data?.vaccinations ?? [];

  // One sheet for create and edit. Bumped `session` remounts it so a second
  // open never shows the first's values.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Vaccination | null>(null);
  const [session, setSession] = useState(0);

  const openCreate = () => {
    setEditing(null);
    setSession((n) => n + 1);
    setSheetOpen(true);
  };
  const openEdit = (record: Vaccination) => {
    setEditing(record);
    setSession((n) => n + 1);
    setSheetOpen(true);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span data-tour-id="vaccinations-hero">{t("vaccinations.title")}</span>
        }
        description={t("vaccinations.subtitle")}
        actions={
          <Button
            className="min-h-11 sm:min-h-9"
            data-slot="vaccination-add"
            onClick={openCreate}
          >
            <Plus className="size-4" />
            {t("common.add")}
          </Button>
        }
      />

      <VaccinationSheet
        key={session}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        vaccination={editing}
      />

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : isError ? (
        // A read failure is not an empty Impfpass — surface the error + Retry so
        // an outage never reads as "nothing logged yet".
        <QueryErrorCard
          title={t("vaccinations.listLoadError")}
          onRetry={() => void refetch()}
        />
      ) : records.length > 0 ? (
        <VaccinationList records={records} onEdit={openEdit} />
      ) : (
        <EmptyState
          icon={<Syringe className="size-6" />}
          title={t("vaccinations.empty.title")}
          description={t("vaccinations.empty.description")}
          action={
            <Button
              className="min-h-11 sm:min-h-9"
              data-slot="vaccination-add-empty"
              onClick={openCreate}
            >
              <Plus className="size-4" />
              {t("common.add")}
            </Button>
          }
        />
      )}
    </div>
  );
}
