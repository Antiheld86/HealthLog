"use client";

import { use } from "react";

import { useTranslations } from "@/lib/i18n/context";
import { BackLink } from "@/components/ui/back-link";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { EcgDetail } from "@/components/insights/ecg-detail";

/**
 * `/insights/ecg/[id]` — one ECG recording.
 *
 * The detail used to swap itself into the list card, with its own back
 * button sitting inside the card above the trace. That put the way back
 * BELOW the page heading, which is the one place a back control never
 * belongs, and it left the recording without an address: nothing to deep
 * link, nothing for the browser's own Back to return to.
 *
 * It is a route now, shaped exactly like `/insights/workouts/[id]`: a
 * `BackLink` above the `<SubPageShell>` title, and a body that fetches by
 * id so a cold deep link works without the list.
 */
export default function InsightsEcgDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { t } = useTranslations();
  const { id } = use(params);

  return (
    <SubPageShell
      title={t("insights.ecg.sectionTitle")}
      // No description. The one the list page carries describes the list,
      // and a detail page must not claim to be the list.
      backLink={
        <BackLink
          href="/insights/ecg"
          label={t("insights.ecg.backToList")}
          dataSlot="ecg-detail-back"
        />
      }
    >
      <EcgDetail recordingId={id} />
    </SubPageShell>
  );
}
