export {
  assertRecordSettingsAccess,
  resolveGuardianRecordSettingsAccess,
  type RecordSettingsAccess,
} from "./access";
export { toRecordSettingsDto, type RecordSettingsDto } from "./dto";
export { resolveManagedIntegrationState } from "./integrations";
export {
  classifySettingsDestination,
  isGuardianSettingsWriteAllowed,
  isManageDelegateSettingsDestination,
  SETTINGS_DESTINATION_INVENTORY,
  type SettingsDestinationClassification,
  type SettingsDestinationKind,
} from "./classification";
export {
  isManagedRecordSettingsFamily,
  managedModulePreferencesFrom,
  MANAGED_RECORD_SETTINGS_FIELD_ALLOWLIST,
  MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS,
  MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS,
  parseManagedRecordSettingsPatch,
  safeParseManagedRecordSettingsPatch,
  type ManagedRecordSettingsFamily,
  type ManagedRecordSettingsPatch,
} from "./configuration";
export { assertRecordSettingsResponseForRecord } from "./response";
