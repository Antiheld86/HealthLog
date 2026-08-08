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
 *
 * The list itself arrives with the capture surface; this shell owns the page
 * header, the empty invitation, and the load/error states every module surface
 * shares.
 */
import { Plus, Syringe } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { useTranslations } from "@/lib/i18n/context";

export function VaccinationsView() {
  const { t } = useTranslations();

  return (
    <div className="space-y-6">
      <PageHeader
        title={<span data-tour-id="vaccinations-hero">{t("vaccinations.title")}</span>}
        description={t("vaccinations.subtitle")}
      />

      <EmptyState
        icon={<Syringe className="size-6" />}
        title={t("vaccinations.empty.title")}
        description={t("vaccinations.empty.description")}
        action={
          <Button className="min-h-11 sm:min-h-9" disabled>
            <Plus className="size-4" />
            {t("common.add")}
          </Button>
        }
      />
    </div>
  );
}
