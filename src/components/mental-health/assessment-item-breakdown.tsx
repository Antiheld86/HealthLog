"use client";

/**
 * Per-item answer breakdown for one recorded administration, expanded from a
 * history row. Fetches the detail read (`GET …/assessments/[id]`), which is
 * where the server decrypts `responsesEncrypted` — the answers never ride the
 * list payload.
 *
 * Grammar: the detail surface's label/value rows — official item text muted
 * (validated instrument copy via the SAME `mentalHealth.items.*` keys the
 * check-in wizard renders; never re-worded here), the chosen answer label +
 * its value in foreground. The WHO-5 / SCI recall stems paint once above each
 * run of items, as on the source forms. PHQ-9 item 9 renders like every other
 * item — no alarm colour; the row's existing "support shown" marker is the
 * crisis affordance and is not duplicated here.
 */
import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import {
  INSTRUMENTS,
  optionLabelKey,
  stemKey,
} from "@/lib/mental-health/instruments";

import type { AssessmentDetail, InstrumentId } from "./types";

export function AssessmentItemBreakdown({
  assessmentId,
  instrument,
}: {
  assessmentId: string;
  instrument: InstrumentId;
}) {
  const { t } = useTranslations();
  const def = INSTRUMENTS[instrument];

  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.mentalHealthAssessmentDetail(assessmentId),
    queryFn: () =>
      apiGet<{ assessment: AssessmentDetail }>(
        `/api/mental-health/assessments/${assessmentId}`,
      ),
  });

  if (isPending) {
    return (
      <div
        className="flex flex-col gap-2"
        data-slot="assessment-item-breakdown"
        aria-busy="true"
      >
        {Array.from({ length: def.itemCount }, (_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <p
        className="text-destructive text-sm"
        role="alert"
        data-slot="assessment-item-breakdown"
      >
        {t("mentalHealth.error")}
      </p>
    );
  }

  const detail = data.assessment;
  if (detail.items === null) {
    // The server's honest degrade: the blob exists but cannot be decrypted
    // (key gap / corruption). The score above this breakdown still answers.
    return (
      <p
        className="text-muted-foreground text-sm"
        data-slot="assessment-item-breakdown"
      >
        {t("mentalHealth.history.answersUnavailable")}
      </p>
    );
  }

  return (
    <div
      className="flex flex-col gap-2 text-sm"
      data-slot="assessment-item-breakdown"
    >
      {detail.items.map((value, index) => {
        // Stem captions group runs of items exactly as the wizard presents
        // them: paint the stem only where it differs from the previous item's.
        const stem = stemKey(instrument, index);
        const caption =
          stem !== (index > 0 ? stemKey(instrument, index - 1) : null)
            ? stem
            : null;
        return (
          <div key={index} className="flex flex-col gap-1">
            {caption && (
              <p className="text-muted-foreground pt-1 text-xs">
                {t(`mentalHealth.stems.${caption}`)}
              </p>
            )}
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground min-w-0 flex-1">
                {t(`mentalHealth.items.${def.i18nKey}.${index + 1}`)}
              </span>
              <span className="text-foreground shrink-0 text-right">
                {t(optionLabelKey(instrument, index, value))}
                {" · "}
                <span className="tabular-nums">{value}</span>
              </span>
            </div>
          </div>
        );
      })}
      {detail.functionalDifficulty !== null && (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-muted-foreground min-w-0 flex-1">
            {t("mentalHealth.functionalTitle")}
          </span>
          {/* Unscored follow-up: the label alone, no value — it never counts
              into the total and a number would imply it does. */}
          <span className="text-foreground shrink-0 text-right">
            {t(`mentalHealth.functional.${detail.functionalDifficulty}`)}
          </span>
        </div>
      )}
    </div>
  );
}
