/**
 * Record configuration has its own cache family because it follows the active
 * health record, while `authMe()` remains the person at the keyboard. Keeping
 * the record id in every member prevents an actor cache cell from being read
 * or invalidated as though it belonged to a switched record.
 */
export const recordSettingsKeys = {
  root: () => ["record-settings"] as const,
  detail: (recordId: string) =>
    ["record-settings", recordId, "detail"] as const,
  integrations: (recordId: string) =>
    ["record-settings", recordId, "integrations"] as const,
  profile: (recordId: string) =>
    ["record-settings", recordId, "profile"] as const,
};
