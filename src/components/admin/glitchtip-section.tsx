"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import {
  SettingsToggle,
  useAdminSettings,
  useUpdateSettings,
  ConfiguredBadge,
} from "./_shared";
import { apiPost } from "@/lib/api/api-fetch";

export function GlitchtipSection() {
  const { t } = useTranslations();
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();
  const [glitchtipDsnDraft, setGlitchtipDsnDraft] = useState<string | null>(
    null,
  );
  const [glitchtipEnvironmentDraft, setGlitchtipEnvironmentDraft] = useState<
    string | null
  >(null);

  const glitchtipDsnValue = glitchtipDsnDraft ?? settings?.glitchtipDsn ?? "";
  const glitchtipEnvironmentValue =
    glitchtipEnvironmentDraft ?? settings?.glitchtipEnvironment ?? "production";

  const configured = Boolean(settings?.glitchtipDsn);

  const testGlitchtip = useMutation({
    mutationFn: async () => {
      const data = await apiPost<{ message?: string } | undefined>(
        "/api/admin/monitoring/glitchtip-test",
      );
      return data?.message ?? t("admin.monitoringTestSuccess");
    },
    onSuccess: (message) => {
      toast.success(message);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.monitoringTestFailed"),
      );
    },
  });

  function saveGlitchtipSettings() {
    updateSettings.mutate(
      {
        glitchtipDsn: glitchtipDsnValue,
        glitchtipEnvironment: glitchtipEnvironmentValue,
      },
      {
        onSuccess: () => {
          setGlitchtipDsnDraft(null);
          setGlitchtipEnvironmentDraft(null);
        },
      },
    );
  }

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={AlertTriangle}
        title={t("admin.glitchtipTitle")}
        description={t("admin.glitchtipDescription")}
        status={configured ? <ConfiguredBadge /> : null}
      />

      <div className="space-y-3">
        <SettingsToggle
          label={t("admin.glitchtipEnabled")}
          icon={AlertTriangle}
          checked={settings?.glitchtipEnabled ?? false}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ glitchtipEnabled: checked })
          }
          disabled={updateSettings.isPending}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="admin-glitchtip-dsn" className="text-xs">
              {t("admin.glitchtipDsn")}
            </Label>
            <Input
              id="admin-glitchtip-dsn"
              name="admin-glitchtip-dsn"
              value={glitchtipDsnValue}
              onChange={(event) => setGlitchtipDsnDraft(event.target.value)}
              placeholder={t("admin.glitchtipDsnPlaceholder")}
              autoComplete="new-password"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              disabled={updateSettings.isPending}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-glitchtip-environment" className="text-xs">
              {t("admin.glitchtipEnvironment")}
            </Label>
            <Input
              id="admin-glitchtip-environment"
              name="admin-glitchtip-environment"
              value={glitchtipEnvironmentValue}
              onChange={(event) =>
                setGlitchtipEnvironmentDraft(event.target.value)
              }
              placeholder={t("admin.glitchtipEnvironmentPlaceholder")}
              autoComplete="new-password"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              disabled={updateSettings.isPending}
            />
          </div>
        </div>
      </div>

      <SettingsCardActions>
        <Button
          size="sm"
          variant="outline"
          onClick={() => testGlitchtip.mutate()}
          disabled={testGlitchtip.isPending || updateSettings.isPending}
        >
          {testGlitchtip.isPending && (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("common.test")}
        </Button>
        <Button
          size="sm"
          onClick={saveGlitchtipSettings}
          disabled={updateSettings.isPending}
        >
          {updateSettings.isPending && (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("common.save")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
