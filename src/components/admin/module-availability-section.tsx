"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ToggleLeft } from "lucide-react";
import { toast } from "sonner";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  MODULE_KEYS,
  MODULE_REGISTRY,
  isCodeDisabledModule,
} from "@/lib/modules/registry";
import type { ModuleKey } from "@/lib/modules/registry";
import { SettingsToggle } from "./_shared";
import { apiGet, apiPatch } from "@/lib/api/api-fetch";

/**
 * v1.18.0 — operator-side panel for server-wide module availability, the
 * SECOND layer of the two-layer module model. A module turned off here is
 * off for EVERY account regardless of personal preference — mirroring how
 * the assistant master flag sits above the per-user coach opt-out.
 *
 * Core domains (weight, blood pressure, pulse, medications) are NOT module
 * keys and never appear here; the gate keeps them always-on structurally.
 *
 * UX mirrors the assistant-flags matrix: one toggle per module, calm and
 * neutral, optimistic flip + server confirm via `useMutation`, with a
 * failure toast that reverts by re-invalidating the read query.
 */

type AvailabilityMap = Record<ModuleKey, boolean>;

interface ModuleAvailabilityResponse {
  availability: AvailabilityMap;
}

function useModuleAvailability() {
  return useQuery({
    queryKey: queryKeys.adminModuleAvailability(),
    queryFn: async () => {
      return apiGet<ModuleAvailabilityResponse>(
        "/api/admin/settings/module-availability",
      );
    },
  });
}

function useUpdateModuleAvailability() {
  const client = useQueryClient();
  const { t } = useTranslations();
  return useMutation({
    mutationFn: async (
      patch: Partial<AvailabilityMap>,
    ): Promise<ModuleAvailabilityResponse> => {
      return apiPatch<ModuleAvailabilityResponse>(
        "/api/admin/settings/module-availability",
        patch,
      );
    },
    onSuccess: (data) => {
      client.setQueryData(queryKeys.adminModuleAvailability(), data);
      // The resolved `/api/auth/me` module map depends on this operator
      // layer; bust it so the operator sees the change within the session.
      client.invalidateQueries({ queryKey: queryKeys.authMe() });
      toast.success(t("common.saved"));
    },
    onError: (err) => {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("admin.modules.saveError"),
      );
      client.invalidateQueries({
        queryKey: queryKeys.adminModuleAvailability(),
      });
    },
  });
}

export function ModuleAvailabilitySection() {
  const { t } = useTranslations();
  const { data } = useModuleAvailability();
  const mutation = useUpdateModuleAvailability();

  const availability = data?.availability;

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={ToggleLeft}
        title={t("admin.modules.title")}
        description={t("admin.modules.description")}
      />
      <div className="space-y-4">
        {MODULE_KEYS
          // A module switched off in code (pending a rebuild) is hard-off
          // server-wide; drop its row so the operator toggle can't mislead.
          .filter((key) => !isCodeDisabledModule(key))
          .map((key) => {
            const def = MODULE_REGISTRY[key];
            // Default-available until the read resolves; an explicit `false`
            // from the operator layer is the only thing that turns it off.
            const available = availability?.[key] ?? true;
            return (
              <SettingsToggle
                key={key}
                label={t(def.labelKey)}
                description={t(def.descriptionKey)}
                checked={available}
                onCheckedChange={(checked) =>
                  mutation.mutate({
                    [key]: checked,
                  } as Partial<AvailabilityMap>)
                }
                disabled={mutation.isPending}
              />
            );
          })}
      </div>
    </SettingsCard>
  );
}
