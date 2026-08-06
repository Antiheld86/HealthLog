export type RecordSettingsRelationship =
  | "guardian"
  | "self"
  | "adult-manager";

export interface RecordSettingsAccess {
  actorId: string;
  recordId: string;
  recordKind: "managed" | "self" | "shared";
  relationship: RecordSettingsRelationship;
}

/**
 * Assert a record-settings capability that is deliberately narrower than a
 * general MANAGE grant. A MANAGE grant on an adult's ordinary record is not a
 * route into their identity or configuration.
 */
export function assertRecordSettingsAccess(
  access: RecordSettingsAccess,
  destination: "guardian",
): void {
  if (
    destination === "guardian" &&
    (access.recordKind !== "managed" || access.relationship !== "guardian")
  ) {
    throw new Error("Guardian configuration is unavailable for this record");
  }
}

/**
 * Convert the resolver's authenticated record into the explicit settings
 * boundary. The resolver authenticates the active grant; this function keeps
 * the managed-record marker and relationship requirement visible at every
 * record-settings route.
 */
export function resolveGuardianRecordSettingsAccess(context: {
  actor: { id: string };
  grantId: string | null;
  user: { id: string; managedProfileAt: Date | null };
}): RecordSettingsAccess | null {
  const access: RecordSettingsAccess = {
    actorId: context.actor.id,
    recordId: context.user.id,
    recordKind: context.user.managedProfileAt ? "managed" : "self",
    relationship: context.grantId ? "guardian" : "self",
  };

  try {
    assertRecordSettingsAccess(access, "guardian");
  } catch {
    return null;
  }

  return access;
}
