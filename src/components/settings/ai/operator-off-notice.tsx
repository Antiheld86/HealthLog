"use client";

import { PowerOff } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useAiCapabilityMap } from "@/hooks/use-ai-capability";
import {
  AI_CAPABILITIES,
  AI_CAPABILITY_KEYS,
  AI_OPERATOR_SWITCHES,
  type AiOperatorSwitch,
} from "@/lib/ai/capabilities/types";
import { useTranslations } from "@/lib/i18n/context";

/**
 * Says, in Settings → AI, what the person running this server has switched
 * off, so the settings below never read as broken.
 *
 * Read from the resolved capabilities on `/api/auth/me`: a capability whose
 * reason is `operator_disabled` names the operator switch that covers it, and
 * the notice lists those switches by the names the admin panel uses. With
 * every switch off (the master switch) it says AI is off on this server. With
 * none off it renders nothing. It never offers a control: nothing on this
 * screen can change an operator's switch.
 */
export function OperatorOffNotice() {
  const { t } = useTranslations();
  const capabilities = useAiCapabilityMap();
  if (!capabilities) return null;

  const off = new Set<AiOperatorSwitch>();
  for (const key of AI_CAPABILITY_KEYS) {
    if (capabilities[key]?.reason === "operator_disabled") {
      off.add(AI_CAPABILITIES[key].operatorSwitch);
    }
  }
  if (off.size === 0) return null;

  const allOff = AI_OPERATOR_SWITCHES.every((s) => off.has(s));
  const names = AI_OPERATOR_SWITCHES.filter((s) => off.has(s)).map((s) =>
    t(`admin.assistant.${s}.title`),
  );

  return (
    <SettingsCard data-slot="ai-operator-off-notice">
      <SettingsCardHeader
        icon={PowerOff}
        title={
          allOff
            ? t("settings.ai.operatorOff.allTitle")
            : t("settings.ai.operatorOff.someTitle")
        }
      />
      <p className="text-foreground text-sm">
        {allOff
          ? t("settings.ai.operatorOff.allBody")
          : t("settings.ai.operatorOff.someBody", {
              switches: names.join(", "),
            })}
      </p>
    </SettingsCard>
  );
}
