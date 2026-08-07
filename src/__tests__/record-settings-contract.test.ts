import { describe, expect, it } from "vitest";

import {
  assertRecordSettingsAccess,
  type RecordSettingsAccess,
} from "@/lib/record-settings/access";
import {
  classifySettingsDestination,
  isGuardianSettingsWriteAllowed,
  isManageDelegateSettingsDestination,
  SETTINGS_DESTINATION_INVENTORY,
} from "@/lib/record-settings/classification";
import { RECORD_CONTENT_SECTIONS } from "@/components/settings/record-settings-section-gate";
import { toRecordSettingsDto } from "@/lib/record-settings/dto";
import { resolveManagedIntegrationState } from "@/lib/record-settings/integrations";
import { assertRecordSettingsResponseForRecord } from "@/lib/record-settings/response";
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

  /**
   * v1.37.0 — the anamnesis destination, which is the one piece of record
   * CONTENT under `/settings`.
   *
   * `POST /api/allergies` and `POST /api/family-history` have resolved
   * `requireRecordAuth("manage", "profile")` since MANAGE shipped, while the
   * only form that posts to either was classified unavailable — an admitted
   * write with no reachable caller. These three legs are the classification
   * half of closing that; the integration file drives the routes themselves.
   */
  it("opens the anamnesis destination to everybody the routes already admit", () => {
    expect(classifySettingsDestination("anamnesis")).toEqual({
      kind: "manage-writable",
      guardianWritable: true,
    });
    // The Guardian half. Before this the destination existed and was
    // read-only for the one person the profile exists for.
    expect(isGuardianSettingsWriteAllowed("anamnesis")).toBe(true);
    // The adult-delegate half, and its boundary in the same breath: a MANAGE
    // grant opens the record's health background and nothing else under
    // Settings. Record CONFIGURATION — modules, thresholds, notification
    // routing — stays with the owner even though a Guardian may change it.
    expect(isManageDelegateSettingsDestination("anamnesis")).toBe(true);
    for (const guardianOnly of [
      "account",
      "modules",
      "notifications",
      "thresholds",
      "insights",
      "coach",
      "integrations",
    ]) {
      expect(
        isManageDelegateSettingsDestination(guardianOnly),
        guardianOnly,
      ).toBe(false);
    }
  });

  it("gives every record-content destination a page of its own", () => {
    // Both directions, and the first is the one that matters. `manage-writable`
    // is a classification; the gate has to know which PAGE each slug is, or a
    // destination added to the kind would silently inherit the allergy and
    // family-history managers under its own heading. The map is what says
    // which, and this is what stops the two drifting apart — a new
    // manage-writable slug fails here, at the moment it is added, rather than
    // rendering somebody else's forms.
    const classified = Object.keys(SETTINGS_DESTINATION_INVENTORY)
      .filter(isManageDelegateSettingsDestination)
      .sort();
    const rendered = Object.keys(RECORD_CONTENT_SECTIONS).sort();

    expect(classified).not.toHaveLength(0);
    expect(rendered).toEqual(classified);
  });

  it("leaves exactly one destination on the manage-writable list", () => {
    // The list is short on purpose and a second entry is a consent decision,
    // not a classification tidy-up. Pinning the count means a destination
    // cannot join it as a side effect of somebody reclassifying a neighbour.
    const manageWritable = Object.entries(SETTINGS_DESTINATION_INVENTORY)
      .filter(([, value]) => value.kind === "manage-writable")
      .map(([slug]) => slug);
    expect(manageWritable).toEqual(["anamnesis"]);
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

  it("rejects a late response for another record in a second tab", () => {
    expect(() =>
      assertRecordSettingsResponseForRecord(
        { recordId: "managed-record-b" },
        "managed-record-a",
      ),
    ).toThrow("did not match its key");
    expect(() =>
      assertRecordSettingsResponseForRecord(
        { recordId: "managed-record-a" },
        "managed-record-a",
      ),
    ).not.toThrow();
  });
});
