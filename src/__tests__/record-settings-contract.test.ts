import { describe, expect, it } from "vitest";

import {
  assertRecordSettingsAccess,
  type RecordSettingsAccess,
} from "@/lib/record-settings/access";
import { toRecordSettingsDto } from "@/lib/record-settings/dto";
import { recordSettingsKeys } from "@/lib/query-keys";

describe("record settings contract", () => {
  it("names the target record in both the DTO and cache key", () => {
    const dto = toRecordSettingsDto({
      id: "record-1",
      name: "Managed profile",
      locale: "de",
      timezone: "Europe/Berlin",
      recordKind: "managed",
    });

    expect(dto).toEqual({
      record: {
        id: "record-1",
        displayName: "Managed profile",
        locale: "de",
        timezone: "Europe/Berlin",
        kind: "managed",
      },
    });
    expect(recordSettingsKeys.detail("record-1")).toEqual([
      "record-settings",
      "record-1",
      "detail",
    ]);
  });

  it("does not let an adult MANAGE grant use Guardian-only configuration", () => {
    const access: RecordSettingsAccess = {
      actorId: "adult-manager",
      recordId: "managed-record",
      recordKind: "managed",
      relationship: "adult-manager",
    };

    expect(() => assertRecordSettingsAccess(access, "guardian")).toThrow(
      "Guardian configuration is unavailable for this record",
    );
  });
});
