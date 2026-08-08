"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { SettingsToggle } from "./_shared";
import { apiGet, apiPut } from "@/lib/api/api-fetch";

/**
 * v1.4.31 — operator-side panel for the five assistant feature
 * flags. The master toggle gates the whole assistant; four
 * sub-toggles carve specific surfaces (Coach, Daily Briefing,
 * per-metric status cards, correlation narration).
 *
 * UX:
 *   - Master toggle at the top. When off, the sub-toggles are
 *     visually greyed out (kept rendered so the operator can see
 *     which sub-flags are individually flipped before they unmute
 *     the master) but cannot be flipped via the disabled `<Switch>`.
 *   - Optimistic flip + server confirm via `useMutation`; failure
 *     surfaces a toast and reverts the in-flight toggle by
 *     re-invalidating the read query.
 */

interface AssistantFlagsResponse {
  raw: {
    assistantEnabled: boolean;
    assistantCoachEnabled: boolean;
    assistantBriefingEnabled: boolean;
    assistantInsightStatusEnabled: boolean;
    assistantCorrelationsEnabled: boolean;
  };
  resolved: {
    enabled: boolean;
    coach: boolean;
    briefing: boolean;
    insightStatus: boolean;
    correlations: boolean;
  };
}

function useAssistantFlags() {
  return useQuery({
    queryKey: queryKeys.adminAssistantFlags(),
    queryFn: async () => {
      return apiGet<AssistantFlagsResponse>(
        "/api/admin/settings/assistant-flags",
      );
    },
  });
}

function useUpdateAssistantFlags() {
  const client = useQueryClient();
  const { t } = useTranslations();
  return useMutation({
    mutationFn: async (
      patch: Partial<AssistantFlagsResponse["raw"]>,
    ): Promise<AssistantFlagsResponse> => {
      return apiPut<AssistantFlagsResponse>(
        "/api/admin/settings/assistant-flags",
        patch,
      );
    },
    onSuccess: (data) => {
      client.setQueryData(queryKeys.adminAssistantFlags(), data);
      // Bust the runtime `/api/feature-flags` cache so the operator
      // sees the toggled surface react within the same session.
      client.invalidateQueries({ queryKey: queryKeys.featureFlags() });
      toast.success(t("common.saved"));
    },
    onError: (err) => {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("admin.settingsSaveError"),
      );
      client.invalidateQueries({
        queryKey: queryKeys.adminAssistantFlags(),
      });
    },
  });
}

export function AssistantSection() {
  const { t } = useTranslations();
  const { data } = useAssistantFlags();
  const mutation = useUpdateAssistantFlags();

  const raw = data?.raw;
  const masterOn = raw?.assistantEnabled ?? true;
  const disabledSubs = !masterOn || mutation.isPending;

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Sparkles}
        title={t("admin.assistant.title")}
        description={t("admin.assistant.description")}
      />
      <div className="space-y-4">
        <SettingsToggle
          label={t("admin.assistant.master.title")}
          description={t("admin.assistant.master.description")}
          checked={raw?.assistantEnabled ?? true}
          onCheckedChange={(checked) =>
            mutation.mutate({ assistantEnabled: checked })
          }
          disabled={mutation.isPending}
        />

        <div className="border-border space-y-4 border-t pt-4">
          <SettingsToggle
            label={t("admin.assistant.coach.title")}
            description={t("admin.assistant.coach.description")}
            checked={raw?.assistantCoachEnabled ?? true}
            onCheckedChange={(checked) =>
              mutation.mutate({ assistantCoachEnabled: checked })
            }
            disabled={disabledSubs}
          />
          <SettingsToggle
            label={t("admin.assistant.briefing.title")}
            description={t("admin.assistant.briefing.description")}
            checked={raw?.assistantBriefingEnabled ?? true}
            onCheckedChange={(checked) =>
              mutation.mutate({ assistantBriefingEnabled: checked })
            }
            disabled={disabledSubs}
          />
          <SettingsToggle
            label={t("admin.assistant.insightStatus.title")}
            description={t("admin.assistant.insightStatus.description")}
            checked={raw?.assistantInsightStatusEnabled ?? true}
            onCheckedChange={(checked) =>
              mutation.mutate({ assistantInsightStatusEnabled: checked })
            }
            disabled={disabledSubs}
          />
          <SettingsToggle
            label={t("admin.assistant.correlations.title")}
            description={t("admin.assistant.correlations.description")}
            checked={raw?.assistantCorrelationsEnabled ?? true}
            onCheckedChange={(checked) =>
              mutation.mutate({ assistantCorrelationsEnabled: checked })
            }
            disabled={disabledSubs}
          />
        </div>
      </div>
    </SettingsCard>
  );
}
