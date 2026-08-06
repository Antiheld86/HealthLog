import type {
  AccountAccessEntry,
  AccountRecordKind,
} from "@/lib/sharing/account-access-view";

export type RecordAccessPresentation = "view" | "view-and-add" | "manage";

export interface RecordPresentation {
  access: RecordAccessPresentation;
  recordKind: AccountRecordKind;
}

/**
 * The server publishes both a resolved `canWrite` decision and the canonical
 * three-level label. Chrome binds those values here without treating either as
 * an authorization input: a handler still resolves the active grant afresh.
 */
export function resolveRecordPresentation(
  entry: Pick<AccountAccessEntry, "canWrite" | "level" | "recordKind">,
): RecordPresentation {
  const validRecordKind =
    entry.recordKind === "shared" || entry.recordKind === "managed";
  const validAccess =
    (entry.level === "read" && entry.canWrite === false) ||
    ((entry.level === "write" || entry.level === "manage") &&
      entry.canWrite === true);

  // `parseAccountAccess` normally makes this branch unreachable. Keep the
  // presentation boundary defensive anyway: a stale cache or an untyped
  // consumer must never turn contradictory data into a stronger affordance or
  // claim that the browser is inside somebody else's record.
  if (!validRecordKind || !validAccess) {
    return { access: "view", recordKind: "self" };
  }

  return {
    access:
      entry.level === "manage"
        ? "manage"
        : entry.canWrite
          ? "view-and-add"
          : "view",
    recordKind: entry.recordKind,
  };
}
