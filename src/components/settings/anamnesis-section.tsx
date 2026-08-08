"use client";

/**
 * v1.25 (W-RECORDS) — Settings → Anamnese (medical history).
 *
 * The home for the structured health records: allergies / intolerances and
 * family history. Each is a self-contained CRUD manager rendered in its own
 * card. These are patient-reported reference records — not a time-series
 * signal and not a clinical diagnosis — surfaced alongside the existing
 * tracking-domain settings sections (Labs / Illness / Vorsorge).
 *
 * v1.25.12 — the section is the single home for the pre-existing / chronic
 * conditions the Coach watches, edited inline here so conditions + allergies +
 * family history read (and write) as one coherent medical history. The
 * conditions card is coach-gated (the data only feeds the Coach); it reads and
 * writes the same self-context store (`/api/coach/about-me`) the rest of the app
 * uses — the placement simply moved out of personal context into the medical
 * record where it belongs.
 */

import {
  ClipboardList,
  EyeOff,
  HeartPulse,
  ShieldAlert,
  Users,
} from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { useModuleEnabled } from "@/hooks/use-module-enabled";

import { AllergyManager } from "@/components/records/allergy-manager";
import { ConditionsManager } from "@/components/records/conditions-manager";
import { FamilyHistoryManager } from "@/components/records/family-history-manager";
import { AiProfileInclusionManager } from "@/components/records/ai-profile-inclusion-manager";
import { HealthProfileFactsManager } from "@/components/records/health-profile-facts-manager";

export function AnamnesisSection() {
  const { t } = useTranslations();
  const coachEnabled = useModuleEnabled("coach");
  const insightsEnabled = useModuleEnabled("insights");
  return (
    <div className="space-y-6">
      {(coachEnabled || insightsEnabled) && (
        <SettingsCard>
          <SettingsCardHeader
            icon={EyeOff}
            title={t("records.aiInclusion.cardTitle")}
            description={t("records.aiInclusion.cardDescription")}
          />
          <AiProfileInclusionManager />
        </SettingsCard>
      )}

      {coachEnabled && (
        <SettingsCard>
          <SettingsCardHeader
            icon={HeartPulse}
            title={t("records.conditions.cardTitle")}
            description={t("records.conditions.cardDescription")}
          />
          <ConditionsManager />
        </SettingsCard>
      )}
      <SettingsCard>
        <SettingsCardHeader
          icon={ClipboardList}
          title={t("records.profileFacts.cardTitle")}
          description={t("records.profileFacts.cardDescription")}
        />
        <HealthProfileFactsManager />
      </SettingsCard>

      <SettingsCard>
        <SettingsCardHeader
          icon={ShieldAlert}
          title={t("records.allergies.cardTitle")}
          description={t("records.allergies.cardDescription")}
        />
        <AllergyManager />
      </SettingsCard>

      <SettingsCard>
        <SettingsCardHeader
          icon={Users}
          title={t("records.family.cardTitle")}
          description={t("records.family.cardDescription")}
        />
        <FamilyHistoryManager />
      </SettingsCard>

      <p className="text-muted-foreground text-xs">{t("records.disclaimer")}</p>
    </div>
  );
}
