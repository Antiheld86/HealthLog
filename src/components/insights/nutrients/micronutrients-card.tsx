"use client";

import { useQuery } from "@tanstack/react-query";
import { Leaf } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { binaryReferenceSex } from "@/lib/profile/sex";
import {
  NUTRIENT_CODES,
  isNutrientCode,
  resolveNutrientReference,
  type NutrientCode,
} from "@/lib/nutrients/catalog";
import type { NutrientIntakeOverview } from "./types";

const WINDOW_DAYS = 30;

/** Wire `ug` renders as µg; mg / ml pass through. */
const UNIT_LABELS: Record<string, string> = { mg: "mg", ug: "µg", ml: "ml" };

/** The 24 vitamin/mineral codes — water + caffeine ride their own cards. */
const MICRONUTRIENT_CODES = NUTRIENT_CODES.filter(
  (code) => code !== "water" && code !== "caffeine",
);

function formatAmount(
  fmt: { number: (v: number, d?: number) => string },
  amount: number,
): string {
  return fmt.number(Math.round(amount * 10) / 10, 1);
}

/**
 * v1.29 — micronutrients card on `/insights/nutrients`.
 *
 * Rows ONLY for codes with data in the last 30 days (catalog order),
 * each carrying a latest-day total + a muted "N of 30 days · ref X
 * (EFSA)" meta line — reference omitted when the profile has no sex on
 * file. A muted footer counts "M of 24 tracked"; zero rows collapse the
 * card to a single honest `EmptyState`, never 24 empty rows. No
 * sparkline in slice 1 — sparse series make sparklines lie.
 */
export function MicronutrientsCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  const sex = binaryReferenceSex(user?.gender);

  // A failed read left `data` undefined, `rows` empty, and the card rendered
  // its "no micronutrient data" EmptyState — the same output as an account that
  // genuinely logs no nutrients. The sibling hydration card already routes
  // through QueryErrorCard; this one now matches it.
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.nutrientIntake(WINDOW_DAYS),
    queryFn: () =>
      apiGet<NutrientIntakeOverview>(`/api/nutrients?days=${WINDOW_DAYS}`),
  });

  const rows = (data?.nutrients ?? []).filter(
    (row) =>
      isNutrientCode(row.nutrient) &&
      row.nutrient !== "water" &&
      row.nutrient !== "caffeine",
  );

  return (
    <Card data-slot="nutrients-micronutrients-card">
      <CardHeader>
        <TileHeader icon={Leaf} title={t("nutrients.micronutrients.title")} />
      </CardHeader>
      <CardContent className="space-y-3">
        {isError ? (
          <QueryErrorCard
            title={t("nutrients.micronutrients.loadError")}
            onRetry={() => void refetch()}
          />
        ) : isLoading ? (
          <div className="space-y-1" aria-hidden="true">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Leaf className="size-6" />}
            title={t("nutrients.micronutrients.emptyTitle")}
            size="compact"
          />
        ) : (
          <>
            <ul
              className="divide-border divide-y rounded-md border"
              role="list"
            >
              {rows.map((row) => {
                const reference = resolveNutrientReference(
                  row.nutrient as NutrientCode,
                  sex,
                );
                const unitLabel = UNIT_LABELS[row.unit] ?? row.unit;
                return (
                  <li
                    key={row.nutrient}
                    data-slot="nutrients-micronutrient-row"
                    className="flex items-baseline justify-between gap-3 p-2"
                  >
                    <span className="text-sm">
                      {t(`nutrients.names.${row.nutrient}`)}
                    </span>
                    <span className="flex flex-col items-end gap-0.5 text-right">
                      <span className="text-sm font-medium tabular-nums">
                        {formatAmount(fmt, row.latestAmount)} {unitLabel}
                      </span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {reference
                          ? t("nutrients.micronutrients.rowMeta", {
                              days: row.daysWithData,
                              window: WINDOW_DAYS,
                              value: formatAmount(fmt, reference.value),
                              unit: unitLabel,
                            })
                          : t("nutrients.micronutrients.rowMetaNoRef", {
                              days: row.daysWithData,
                              window: WINDOW_DAYS,
                            })}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-muted-foreground text-xs">
              {t("nutrients.micronutrients.footer", {
                tracked: rows.length,
                total: MICRONUTRIENT_CODES.length,
              })}
            </p>
          </>
        )}
        <p className="text-muted-foreground text-sm">
          {t("nutrients.sparseNote")}
        </p>
      </CardContent>
    </Card>
  );
}
