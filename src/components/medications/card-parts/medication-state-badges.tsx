import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";

interface MedicationStateBadgesProps {
  notificationsEnabled: boolean;
  active: boolean;
  pausedAt: string | null;
  /** v1.39.1 (#1033) — intake tracking off: kept as a record only. */
  recordOnly?: boolean;
  /** v1.39.4 (#1040) — the course's end date has passed. */
  courseEnded?: boolean;
}

/**
 * Shared "without notification" / "inactive" / "paused since …" badge pair
 * rendered in the medication-card header. Extracted from the generic and
 * GLP-1 cards so the two variants stay structurally symmetric instead of
 * hand-synced.
 */
export function MedicationStateBadges({
  notificationsEnabled,
  active,
  pausedAt,
  recordOnly = false,
  courseEnded = false,
}: MedicationStateBadgesProps) {
  const { t } = useTranslations();

  return (
    <>
      {recordOnly && (
        <Badge
          variant="secondary"
          className="text-xs"
          data-slot="medication-record-only-badge"
        >
          {t("medications.recordOnlyBadge")}
        </Badge>
      )}
      {courseEnded && (
        <Badge
          variant="secondary"
          className="text-xs"
          data-slot="medication-course-ended-badge"
        >
          {t("medications.courseEndedBadge")}
        </Badge>
      )}
      {!notificationsEnabled && !recordOnly && !courseEnded && (
        <Badge variant="secondary" className="text-xs">
          {t("medications.withoutNotification")}
        </Badge>
      )}
      {!active && (
        <Badge variant="secondary" className="text-xs">
          {pausedAt
            ? `${t("medications.pausedSince")} ${formatDateTime(pausedAt)}`
            : t("medications.inactive")}
        </Badge>
      )}
    </>
  );
}
