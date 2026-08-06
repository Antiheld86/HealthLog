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
