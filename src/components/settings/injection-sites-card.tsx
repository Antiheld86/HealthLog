"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Syringe } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Checkbox } from "@/components/ui/checkbox";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  INJECTION_SITE_KEYS,
  describeInjectionSite,
  type InjectionSiteKey,
} from "@/lib/medications/injection-sites";
import { apiFetchRaw, apiPatch } from "@/lib/api/api-fetch";

/**
 * v1.8.5 — Settings → global injection-site exclusion.
 *
 * A per-user deny-list. Sites checked here are never offered for any
 * medication's injection-site picker and are rejected (422) at intake —
 * even when a medication lists them as preferred (deny always wins).
 * Reads + PATCHes `GET/PATCH /api/auth/me/injection-site-prefs`; the
 * mutation invalidates `injectionSitePrefs()` so every picker re-reads.
 */
export function InjectionSitesCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: queryKeys.injectionSitePrefs(),
    queryFn: async () => {
      const res = await apiFetchRaw("/api/auth/me/injection-site-prefs");
      if (!res.ok) return [] as InjectionSiteKey[];
      const json = await res.json();
      return (json.data?.globalExcludedInjectionSites ??
        []) as InjectionSiteKey[];
    },
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });
  const excluded: InjectionSiteKey[] = data ?? [];

  const mutation = useMutation({
    mutationFn: async (next: InjectionSiteKey[]) => {
      await apiPatch("/api/auth/me/injection-site-prefs", {
        globalExcludedInjectionSites: next,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.injectionSitePrefs(),
      });
    },
  });

  function toggle(site: InjectionSiteKey, checked: boolean) {
    const set = new Set(excluded);
    if (checked) set.add(site);
    else set.delete(site);
    mutation.mutate(INJECTION_SITE_KEYS.filter((s) => set.has(s)));
  }

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Syringe}
        title={t("settings.globalExcludedInjectionSitesLabel")}
        description={t("settings.globalExcludedInjectionSitesHint")}
      />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {INJECTION_SITE_KEYS.map((site) => (
          <label key={site} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={excluded.includes(site)}
              disabled={mutation.isPending}
              onCheckedChange={(c) => toggle(site, c === true)}
            />
            {t(describeInjectionSite(site))}
          </label>
        ))}
      </div>
    </SettingsCard>
  );
}
