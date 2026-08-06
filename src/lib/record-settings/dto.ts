export interface RecordSettingsDto {
  record: {
    id: string;
    displayName: string;
    locale: string | null;
    timezone: string;
    kind: "managed";
  };
}

/**
 * The record-settings payload intentionally names the record it describes.
 * It is never an extension of `/api/auth/me`, which remains the actor's
 * identity payload while the browser is switched into another record.
 */
export function toRecordSettingsDto(source: {
  id: string;
  name: string | null;
  locale: string | null;
  timezone: string;
  recordKind: "managed";
}): RecordSettingsDto {
  return {
    record: {
      id: source.id,
      displayName: source.name ?? "",
      locale: source.locale,
      timezone: source.timezone,
      kind: source.recordKind,
    },
  };
}
