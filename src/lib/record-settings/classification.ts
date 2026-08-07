import type { SettingsSectionSlug } from "@/components/settings/section-slugs";

export type SettingsDestinationKind =
  | "personal"
  | "managed-guardian"
  | "manage-writable"
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

/**
 * v1.37.0 — reachable by everybody the record routes behind it already admit.
 *
 * The other four kinds each answer for one population. `MANAGED_GUARDIAN` is
 * guardian-only; `ADULT_SHARED_UNAVAILABLE` is closed to adult shares and open
 * to nobody else; neither can express "the same set the route admits", which
 * for the anamnesis surface is a Guardian on a managed profile AND an adult
 * delegate holding MANAGE.
 *
 * That gap had a consequence rather than being a taxonomy nicety. `POST
 * /api/allergies` and `POST /api/family-history` both resolve
 * `requireRecordAuth("manage", "profile")` — the write is admitted, audited
 * and owner-scoped — while the only form in the product that posts to either
 * lives under Settings → Anamnese, which was classified unavailable. An
 * admitted write with no reachable caller is the one-ended change this
 * repository keeps rediscovering: the permission ships, the surface is "the
 * follow-up", and every other check proves the other end.
 *
 * `guardianWritable` is true because a Guardian writes here too; the kind is
 * what says the destination is not guardian-ONLY.
 */
const MANAGE_WRITABLE: SettingsDestinationClassification = {
  kind: "manage-writable",
  guardianWritable: true,
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
  anamnesis: MANAGE_WRITABLE,
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
} as const satisfies Record<
  SettingsSectionSlug,
  SettingsDestinationClassification
>;

export function classifySettingsDestination(
  destination: string,
): SettingsDestinationClassification {
  return (
    SETTINGS_DESTINATION_INVENTORY[destination as SettingsSectionSlug] ??
    UNAVAILABLE
  );
}

/**
 * May a Guardian change this destination inside the profile they administer.
 *
 * Two kinds qualify, and the second is not a widening of the first: a
 * `manage-writable` destination is one the record routes already admit at
 * MANAGE, and a Guardian holds MANAGE by construction. Naming only
 * `managed-guardian` here would have left the anamnesis destination visible
 * and read-only for the one person the record exists for.
 */
export function isGuardianSettingsWriteAllowed(destination: string): boolean {
  const classification = classifySettingsDestination(destination);
  return (
    (classification.kind === "managed-guardian" ||
      classification.kind === "manage-writable") &&
    classification.guardianWritable
  );
}

/**
 * Is this destination part of the record surface an adult MANAGE grant opens.
 *
 * Deliberately narrower than {@link isGuardianSettingsWriteAllowed}: a
 * Guardian administers a profile and reaches the record's configuration —
 * modules, thresholds, notification routing — while an adult delegate reaches
 * only the health record itself. `manage-writable` is the one kind that is
 * record content rather than record configuration, so it is the only kind an
 * ordinary shared record opens under `/settings`.
 */
export function isManageDelegateSettingsDestination(
  destination: string,
): boolean {
  return classifySettingsDestination(destination).kind === "manage-writable";
}
