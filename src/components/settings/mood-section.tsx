"use client";

import { Archive, Folders, Loader2, Tags } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ArchivedTagsCard } from "@/components/mood/manage/archived-tags-card";
import { TagGroupsCard } from "@/components/mood/manage/tag-groups-card";
import { TagManagerCard } from "@/components/mood/manage/tag-manager-card";
import { useMoodTagManage } from "@/components/mood/manage/use-mood-tag-manage";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.17 — the "Stimmungs-Tags" settings section (`/settings/mood`),
 * following the medications-section card pattern. Hosts the whole
 * mood-tag management surface in three blocks:
 *   1. Groups — create / rename / delete own groups, drag + arrow
 *      reorder of the picker's group order.
 *   2. Tags — per-group tag list mirroring the picker: hide/show
 *      catalogue tags, edit / move / archive custom tags, drag + arrow
 *      reorder, create.
 *   3. Archived — archived custom tags with restore and the explicit
 *      hard-delete path.
 *
 * One management read (`useMoodTagManage`) feeds all three cards — the
 * section never waterfalls; every mutation invalidates the
 * `["mood-tag-catalog"]` prefix so the mood form's picker repaints in
 * the same tick.
 */

export function MoodSection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const { data: catalog, isLoading } = useMoodTagManage(isAuthenticated);

  const loading = (
    <div className="text-muted-foreground flex items-center gap-2 text-sm">
      <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
      {t("common.loading")}
    </div>
  );

  // v1.18.6 (W9) — the visible heading + subtitle now come from the shared
  // `<SettingsSectionFrame>` in the route; this body is the mood-tag cards.
  return (
    <div className="space-y-6">
      {/* Groups — picker group order + own groups. */}
      <SettingsCard id="mood-groups" className="scroll-mt-28">
        <SettingsCardHeader
          icon={Folders}
          title={t("mood.manage.groupsTitle")}
        />
        {isLoading || !catalog ? loading : <TagGroupsCard catalog={catalog} />}
      </SettingsCard>

      {/* Tags — visibility, order, edit, move, create. */}
      <SettingsCard id="mood-tags" className="scroll-mt-28">
        <SettingsCardHeader icon={Tags} title={t("mood.manage.tagsTitle")} />
        {isLoading || !catalog ? loading : <TagManagerCard catalog={catalog} />}
      </SettingsCard>

      {/* Archived custom tags — restore / hard delete. */}
      <SettingsCard id="mood-archived" className="scroll-mt-28">
        <SettingsCardHeader
          icon={Archive}
          title={t("mood.manage.archivedTitle")}
        />
        {isLoading || !catalog ? (
          loading
        ) : (
          <ArchivedTagsCard catalog={catalog} />
        )}
      </SettingsCard>
    </div>
  );
}
