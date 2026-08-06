import type { SettingsSectionSlug } from "@/components/settings/section-slugs";

export type SettingsDestinationKind =
  | "personal"
  | "managed-guardian"
  | "adult-shared-unavailable"
  | "unavailable";

export interface SettingsDestinationClassification {
  kind: SettingsDestinationKind;
  guardianWritable: boolean;
}

const PERSONAL: SettingsDestinationClassification = {
  kind: "personal",
  guardianWritable: false,
};

const MANAGED_GUARDIAN: SettingsDestinationClassification = {
  kind: "managed-guardian",
  guardianWritable: true,
};

const MANAGED_GUARDIAN_STATUS: SettingsDestinationClassification = {
  kind: "managed-guardian",
  guardianWritable: false,
};

const ADULT_SHARED_UNAVAILABLE: SettingsDestinationClassification = {
  kind: "adult-shared-unavailable",
  guardianWritable: false,
};

const UNAVAILABLE: SettingsDestinationClassification = {
  kind: "unavailable",
  guardianWritable: false,
};

/**
 * The complete Settings route inventory. `satisfies Record<SettingsSectionSlug,
 * ...>` makes adding a new destination a compile error until its record
 * classification is reviewed. Unknown destinations resolve to unavailable so
 * direct links fail closed rather than inheriting a neighbouring category.
 */
export const SETTINGS_DESTINATION_INVENTORY = {
  account: MANAGED_GUARDIAN,
  security: PERSONAL,
  access: PERSONAL,
  modules: MANAGED_GUARDIAN,
  integrations: MANAGED_GUARDIAN_STATUS,
  sources: UNAVAILABLE,
  notifications: MANAGED_GUARDIAN,
  layout: ADULT_SHARED_UNAVAILABLE,
  dashboard: ADULT_SHARED_UNAVAILABLE,
  insights: MANAGED_GUARDIAN,
  medications: ADULT_SHARED_UNAVAILABLE,
  mood: ADULT_SHARED_UNAVAILABLE,
  labs: ADULT_SHARED_UNAVAILABLE,
  illness: ADULT_SHARED_UNAVAILABLE,
  environment: UNAVAILABLE,
  anamnesis: ADULT_SHARED_UNAVAILABLE,
  score: ADULT_SHARED_UNAVAILABLE,
  vorsorge: ADULT_SHARED_UNAVAILABLE,
  thresholds: MANAGED_GUARDIAN,
  ai: UNAVAILABLE,
  coach: MANAGED_GUARDIAN,
  api: PERSONAL,
  mcp: PERSONAL,
  gesundheitsakte: PERSONAL,
  sharing: UNAVAILABLE,
  export: PERSONAL,
  advanced: PERSONAL,
  privacy: PERSONAL,
  about: PERSONAL,
} as const satisfies Record<SettingsSectionSlug, SettingsDestinationClassification>;

export function classifySettingsDestination(
  destination: string,
): SettingsDestinationClassification {
  return (
    SETTINGS_DESTINATION_INVENTORY[
      destination as SettingsSectionSlug
    ] ?? UNAVAILABLE
  );
}

export function isGuardianSettingsWriteAllowed(destination: string): boolean {
  const classification = classifySettingsDestination(destination);
  return (
    classification.kind === "managed-guardian" &&
    classification.guardianWritable
  );
}
