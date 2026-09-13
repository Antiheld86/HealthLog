import {
  SETTINGS_SECTION_SLUGS,
  type SettingsSectionSlug,
} from "@/components/settings/section-slugs";
import type {
  AccountAccessLevel,
  AccountRecordKind,
} from "@/lib/sharing/account-access-view";

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
  environment: UNAVAILABLE,
  anamnesis: MANAGE_WRITABLE,
  score: ADULT_SHARED_UNAVAILABLE,
  thresholds: MANAGED_GUARDIAN,
  ai: UNAVAILABLE,
  coach: MANAGED_GUARDIAN,
  api: PERSONAL,
  mcp: PERSONAL,
  gesundheitsakte: PERSONAL,
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

/**
 * The record a Settings listing is drawn for: the server-resolved kind of the
 * record on screen and the level of the grant that opened it. `level` is null
 * in one's own record and in a context the client could not prove.
 */
export interface SettingsRecordContext {
  recordKind: AccountRecordKind;
  level: AccountAccessLevel | null;
}

/**
 * Does the Settings shell list this destination inside a shared record.
 *
 * The one answer both the shell's section list and the app navigation read,
 * so the navigation cannot offer a Settings entry the shell has nothing
 * behind, nor withhold one the shell would list.
 *
 *   * A managed profile at MANAGE lists its guardian configuration and the
 *     record content a MANAGE holder may write. The guardian holds MANAGE, so
 *     the second set is theirs as well.
 *   * An ordinary shared record at MANAGE lists only the record content. A
 *     delegate manages somebody's health record, not their account: modules,
 *     thresholds and notification routing stay with the owner.
 *   * Every other context lists nothing.
 *
 * Every destination on either list needs MANAGE, so the level is checked once
 * for both record kinds. A guardian grant is always MANAGE today, which is
 * exactly why the check was easy to leave out, and a managed entry that ever
 * arrived below it would have listed destinations the section gate refuses.
 *
 * Paint only. The section gate still refuses any direct URL on its own.
 */
export function isSettingsDestinationListedForRecord(
  destination: string,
  record: SettingsRecordContext,
): boolean {
  if (record.level !== "manage") return false;
  const kind = classifySettingsDestination(destination).kind;
  if (record.recordKind === "managed") {
    return kind === "managed-guardian" || kind === "manage-writable";
  }
  if (record.recordKind === "shared") return kind === "manage-writable";
  return false;
}

/**
 * The Settings page a navigation entry opens inside a shared record, or null
 * when the shell would list nothing there and no entry should be offered.
 *
 * `order` is the order the shell lists its sections in. The navigation passes
 * the slug registry, whose order differs from the shell's in general; the
 * parity test in `nav-model-shared-record.test.ts` holds the first answer
 * equal to the first section the shell actually lists, for every record kind,
 * so a reorder on either side fails there rather than landing somebody on a
 * page the shell does not open with.
 */
export function recordSettingsLandingDestination(
  record: SettingsRecordContext,
  order: readonly SettingsSectionSlug[] = SETTINGS_SECTION_SLUGS,
): SettingsSectionSlug | null {
  return (
    order.find((slug) => isSettingsDestinationListedForRecord(slug, record)) ??
    null
  );
}
