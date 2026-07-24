"use client";

/**
 * v1.28.21 — compact GLP-1 weight-plateau note.
 *
 * Renders the existing server-side plateau detection (`detectGlp1Plateau`,
 * until now prompt-only) as a discreet card on both GLP-1 curve surfaces:
 * the medication detail "Wirkung" tab (below the estimated
 * active-substance curve) and /insights/medications (below the same curve
 * block). Reads `GET /api/insights/glp1-plateau`; when the detector
 * returns `null` (no active GLP-1 medication, < 21 days on the current
 * dose, weight still dropping, or too few readings) the card renders
 * nothing.
 *
 * Association only, matching the efficacy-tab posture: the copy is a
 * title + one evidence line (Δ kg over the window, reading count, days on
 * the current dose) — no verdict, no advice, no dose suggestion. The
 * strings live under `medications.efficacy.plateau.*` so the banned-verb
 * guard (`medications-efficacy-verb-guard.test.ts`) covers them
 * structurally.
 */
import { Scale } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import type { Glp1PlateauContext } from "@/lib/insights/glp1-plateau";

interface Glp1PlateauResponse {
  plateau: Glp1PlateauContext | null;
  windowDays: number;
}

export function Glp1PlateauNote() {
  const { t } = useTranslations();
  const unitDisplay = useUnitDisplay();
  const { data } = useQuery({
    queryKey: queryKeys.insightsGlp1Plateau(),
    queryFn: () => apiGet<Glp1PlateauResponse>("/api/insights/glp1-plateau"),
    staleTime: 60_000,
  });

  if (!data?.plateau) return null;
  const plateau = data.plateau;

  // The weight change is a DELTA → factor-only conversion (no affine offset).
  const deltaValue =
    Math.round(
      unitDisplay.toDisplayDelta("WEIGHT", plateau.weightDeltaKg) * 10,
    ) / 10;
  const delta = deltaValue > 0 ? `+${deltaValue}` : `${deltaValue}`;
  const unit = unitDisplay.unitFor("WEIGHT");
  const dose = `${plateau.drug} ${plateau.doseValue} ${plateau.doseUnit}`;

  return (
    <Card className="gap-2 py-3 md:py-4" data-slot="glp1-plateau-note">
      <CardHeader>
        <TileHeader
          size="sm"
          icon={Scale}
          title={t("medications.efficacy.plateau.title")}
        />
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-sm">
          {t("medications.efficacy.plateau.evidence", {
            delta,
            unit,
            window: data.windowDays,
            readings: plateau.readingsCount,
            days: plateau.daysOnDose,
            dose,
          })}
        </p>
      </CardContent>
    </Card>
  );
}
