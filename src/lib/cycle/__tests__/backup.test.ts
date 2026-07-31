import { describe, expect, it, vi } from "vitest";

import { buildCycleBackupSection } from "../backup";

const deletedAt = new Date("2026-07-19T12:00:00.000Z");
const createdAt = new Date("2026-07-01T08:00:00.000Z");
const updatedAt = new Date("2026-07-19T11:00:00.000Z");

describe("buildCycleBackupSection disaster-recovery mode", () => {
  it("preserves stable ids, reconciliation fields, and tombstones", async () => {
    const prisma = {
      cycleProfile: {
        findUnique: vi.fn().mockResolvedValue({
          id: "profile-dr",
          goal: "GENERAL_HEALTH",
          cycleTrackingEnabled: true,
          typicalCycleLength: 28,
          typicalPeriodLength: 5,
          lutealPhaseLength: 14,
          secondarySymptom: "MUCUS",
          predictionEnabled: true,
          rawChartMode: false,
          discreetNotifications: true,
          sensitiveCategoryEncryption: true,
          createdAt,
          updatedAt,
        }),
      },
      cycleSymptom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "sym-custom",
            key: "custom_ache",
            labelKey: "cycle.symptom.custom_ache",
            categoryId: "cat-1",
            icon: "Activity",
            sortOrder: 3,
            isActive: true,
          },
        ]),
      },
      menstrualCycle: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "cycle-dr",
            startDate: "2026-07-01",
            endDate: "2026-07-28",
            periodEndDate: "2026-07-05",
            lengthDays: 28,
            ovulationDate: "2026-07-14",
            ovulationConfirmed: true,
            isPredicted: false,
            tz: "Europe/London",
            syncVersion: 5,
            deletedAt,
            createdAt,
            updatedAt,
          },
        ]),
      },
      cycleDayLog: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "cycle-day-dr",
            date: "2026-07-02",
            cycleId: "cycle-dr",
            flow: "HEAVY",
            intermenstrualBleeding: false,
            basalBodyTempC: 36.7,
            temperatureExcluded: true,
            ovulationTest: "NEGATIVE",
            cervicalMucus: "CREAMY",
            cervixPosition: "LOW",
            cervixFirmness: "FIRM",
            cervixOpening: "CLOSED",
            sexualActivity: false,
            protectedSex: null,
            pregnancyTest: null,
            progesteroneTest: null,
            contraceptive: null,
            sensitiveEncrypted: "sensitive-ciphertext",
            notesEncrypted: "notes-ciphertext",
            source: "APPLE_HEALTH",
            externalId: "cycle-day-external",
            tz: "Europe/London",
            syncVersion: 9,
            deletedAt,
            createdAt,
            updatedAt,
            // One symptom the person put a number on, one they did not.
            symptomLinks: [
              { severity: 4, symptom: { key: "cramps" } },
              { severity: null, symptom: { key: "fatigue" } },
            ],
          },
        ]),
      },
    };

    const section = await buildCycleBackupSection(prisma as never, "user-1", {
      purpose: "disaster-recovery",
    });

    expect(prisma.menstrualCycle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect(prisma.cycleDayLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect(section.cycleProfile).toEqual({
      id: "profile-dr",
      goal: "GENERAL_HEALTH",
      cycleTrackingEnabled: true,
      typicalCycleLength: 28,
      typicalPeriodLength: 5,
      lutealPhaseLength: 14,
      secondarySymptom: "MUCUS",
      predictionEnabled: true,
      rawChartMode: false,
      discreetNotifications: true,
      sensitiveCategoryEncryption: true,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(section.cycles[0]).toEqual({
      id: "cycle-dr",
      startDate: "2026-07-01",
      endDate: "2026-07-28",
      periodEndDate: "2026-07-05",
      lengthDays: 28,
      ovulationDate: "2026-07-14",
      ovulationConfirmed: true,
      isPredicted: false,
      tz: "Europe/London",
      syncVersion: 5,
      deletedAt: deletedAt.toISOString(),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(section.cycleDayLogs[0]).toEqual({
      id: "cycle-day-dr",
      date: "2026-07-02",
      cycleId: "cycle-dr",
      flow: "HEAVY",
      intermenstrualBleeding: false,
      basalBodyTempC: 36.7,
      temperatureExcluded: true,
      ovulationTest: "NEGATIVE",
      cervicalMucus: "CREAMY",
      cervixPosition: "LOW",
      cervixFirmness: "FIRM",
      cervixOpening: "CLOSED",
      sexualActivity: false,
      protectedSex: null,
      pregnancyTest: null,
      progesteroneTest: null,
      contraceptive: null,
      sensitiveEncrypted: "sensitive-ciphertext",
      notesEncrypted: "notes-ciphertext",
      source: "APPLE_HEALTH",
      externalId: "cycle-day-external",
      tz: "Europe/London",
      syncVersion: 9,
      deletedAt: deletedAt.toISOString(),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      symptomKeys: ["cramps", "fatigue"],
      // Only the rated link is listed. An unrated one is left out rather than
      // written as a zero, so the file says "never rated" and not "rated none".
      symptomSeverities: [{ key: "cramps", severity: 4 }],
    });
  });
});

describe("a symptom the account created survives the round trip", () => {
  /**
   * The defect this pins: the seeded symptom catalogue is reference data every
   * instance already has, but a symptom the user made exists only in their
   * account. It was never carried, so on restore its key resolved to nothing —
   * and the link was silently filtered out. The day-log came back, one of its
   * symptoms did not, and the restore reported success.
   */
  function client(customSymptoms: unknown[]) {
    return {
      cycleProfile: { findUnique: vi.fn().mockResolvedValue(null) },
      menstrualCycle: { findMany: vi.fn().mockResolvedValue([]) },
      cycleDayLog: { findMany: vi.fn().mockResolvedValue([]) },
      cycleSymptom: { findMany: vi.fn().mockResolvedValue(customSymptoms) },
    } as never;
  }

  it("carries the account's own symptom definitions", async () => {
    const section = await buildCycleBackupSection(
      client([
        {
          id: "sym-1",
          key: "custom_ache",
          labelKey: "cycle.symptom.custom_ache",
          categoryId: "cat-1",
          icon: null,
          sortOrder: 2,
          isActive: true,
        },
      ]),
      "user-1",
      { purpose: "disaster-recovery" },
    );

    expect(section.customSymptoms).toHaveLength(1);
    expect(section.customSymptoms[0]).toMatchObject({
      key: "custom_ache",
      labelKey: "cycle.symptom.custom_ache",
      categoryId: "cat-1",
      sortOrder: 2,
      isActive: true,
    });
  });

  it("asks only for the account's own rows, never the seeded catalogue", async () => {
    // Carrying the seeded rows would let one instance's restore rewrite
    // another instance's reference data.
    const c = client([]);
    await buildCycleBackupSection(c, "user-1", {});
    expect(
      (c as unknown as { cycleSymptom: { findMany: ReturnType<typeof vi.fn> } })
        .cycleSymptom.findMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
  });

  it("writes an empty list rather than omitting the section", async () => {
    // An absent key and an empty list read the same to a careless consumer.
    // The restore distinguishes them, so the builder must be explicit.
    const section = await buildCycleBackupSection(client([]), "user-1", {});
    expect(section.customSymptoms).toEqual([]);
  });
});
