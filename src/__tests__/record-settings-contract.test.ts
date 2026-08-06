import { describe, expect, it } from "vitest";

import {
  assertRecordSettingsAccess,
  type RecordSettingsAccess,
} from "@/lib/record-settings/access";
import {
  classifySettingsDestination,
  isGuardianSettingsWriteAllowed,
  SETTINGS_DESTINATION_INVENTORY,
} from "@/lib/record-settings/classification";
import { toRecordSettingsDto } from "@/lib/record-settings/dto";
import { resolveManagedIntegrationState } from "@/lib/record-settings/integrations";
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
    expect(recordSettingsKeys.recordSettingsIntegrations("record-1")).toEqual([
      "record-settings",
      "record-1",
      "integrations",
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

  it("classifies every Settings destination and limits Guardian writes", () => {
    expect(Object.keys(SETTINGS_DESTINATION_INVENTORY)).not.toHaveLength(0);
    expect(classifySettingsDestination("integrations")).toMatchObject({
      kind: "managed-guardian",
      guardianWritable: false,
    });
    expect(classifySettingsDestination("ai").kind).toBe("unavailable");
    expect(classifySettingsDestination("dashboard").kind).toBe(
      "adult-shared-unavailable",
    );
    expect(isGuardianSettingsWriteAllowed("account")).toBe(true);
    expect(isGuardianSettingsWriteAllowed("notifications")).toBe(true);
    expect(isGuardianSettingsWriteAllowed("integrations")).toBe(false);
    expect(isGuardianSettingsWriteAllowed("ai")).toBe(false);
  });

  it("does not report a synthetic ledger row as a managed connection", () => {
    const connected = {
      withings: false,
      whoop: false,
      fitbit: false,
      nightscout: false,
      polar: false,
      oura: false,
      "google-health": false,
      strava: false,
    } as const;

    expect(
      resolveManagedIntegrationState("connected", connected, "withings"),
    ).toBe("disconnected");
    expect(
      resolveManagedIntegrationState(
        "error_reauth",
        { ...connected, oura: true },
        "oura",
      ),
    ).toBe("error_reauth");
  });
});
