"use client";

import { Bell, Globe, Key, MessageCircle } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { SettingsToggle, useAdminSettings, useUpdateSettings } from "./_shared";

export function ServicesSection() {
  const { t } = useTranslations();
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Globe}
        title={t("admin.servicesGlobal")}
        description={t("admin.servicesGlobalDescription")}
      />
      <div className="space-y-3">
        <SettingsToggle
          label="Telegram"
          description={t("admin.telegramGlobal")}
          icon={MessageCircle}
          checked={settings?.telegramGlobal ?? true}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ telegramGlobal: checked })
          }
          disabled={updateSettings.isPending}
        />
        <SettingsToggle
          label="ntfy"
          description={t("admin.ntfyGlobal")}
          icon={Bell}
          checked={settings?.ntfyGlobal ?? true}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ ntfyGlobal: checked })
          }
          disabled={updateSettings.isPending}
        />
        <SettingsToggle
          label={t("admin.integrationWebPush")}
          description={t("admin.webPushGlobal")}
          icon={Globe}
          checked={settings?.webPushGlobal ?? true}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ webPushGlobal: checked })
          }
          disabled={updateSettings.isPending}
        />
        <SettingsToggle
          label="API"
          description={t("admin.apiGlobal")}
          icon={Key}
          checked={settings?.apiGlobal ?? true}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ apiGlobal: checked })
          }
          disabled={updateSettings.isPending}
        />
      </div>
    </SettingsCard>
  );
}
