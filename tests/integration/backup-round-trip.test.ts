/**
 * Every model the plan claims travels both ways, proven by making it travel.
 *
 * `src/__tests__/backup-plan-classification.test.ts` reads source text. That
 * catches a reader or a restore branch that was never written, and it is cheap
 * enough to run on every `pnpm test` — but it cannot tell a branch that RUNS
 * from one that merely exists. Verified rather than assumed: wrapping the
 * nutrient restore in `if (false && …)` left all twelve of its checks green.
 * Correct, green, and inert in production is the failure mode this repository
 * has already shipped once, so the claim needs an end-to-end answer as well.
 *
 * This is that answer, and it is deliberately the LONG way round:
 *
 *   1. Seed one row of every model in `TWO_ENDED_MODELS` for one account.
 *   2. Export through the real `buildFullBackupPayload`, disaster-recovery
 *      purpose — the same builder both export routes and the weekly worker use.
 *   3. Delete the account. Not a hand-listed `deleteMany` sweep, which can only
 *      empty the tables somebody remembered: `user.delete()` cascades, so what
 *      survives is exactly what the schema says survives. A model that is
 *      neither wiped nor restored would otherwise be counted as recovered on
 *      the strength of the row that was never removed.
 *   4. Re-create the account under the same id and restore through the real
 *      `POST /api/admin/backups/[id]/restore`.
 *   5. Count each model back. Zero means the account came back short.
 *
 * The registry below is keyed by `TwoEndedModel`, so a name added to the plan's
 * two-ended list without a row seeded and counted here does not compile.
 *
 * What this still does not prove, with one exception: that a restored row
 * carries the right VALUES. It asks whether the rows came back, not whether
 * they came back intact — `admin-backups-canonical-roundtrip.test.ts` is where
 * field-level fidelity is asserted. A restore that wrote one row per model with
 * every column defaulted would satisfy this file and fail that one.
 *
 * The exception is the medication side effect. Its note lives in an encrypted
 * column beside a legacy plaintext one, so "the row came back" and "the note
 * came back" are genuinely different answers here: a restore that dropped the
 * ciphertext would still be counted as recovered by everything above. The
 * severity, the category and the entry are asserted alongside it, because a
 * side effect without them says something happened and not what.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import type { PrismaClient } from "@/generated/prisma/client";
import { encrypt, encryptBytes } from "@/lib/crypto";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { readNote } from "@/lib/crypto/note-cipher";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { TWO_ENDED_MODELS, type TwoEndedModel } from "@/lib/export/backup-plan";
import { POST } from "@/app/api/admin/backups/[id]/restore/route";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserData: vi.fn(),
}));

const OWNER_ID = "round-trip-owner";
const AT = (iso: string) => new Date(iso);
const SIDE_EFFECT_NOTE = "nausea for two hours after the evening dose";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

/** Counts what belongs to `userId`, following the relation where there is no own column. */
const COUNT_BACK: Record<
  TwoEndedModel,
  (prisma: PrismaClient, userId: string) => Promise<number>
> = {
  Measurement: (p, userId) => p.measurement.count({ where: { userId } }),
  IntradayCumulativeProfile: (p, userId) =>
    p.intradayCumulativeProfile.count({ where: { userId } }),
  Medication: (p, userId) => p.medication.count({ where: { userId } }),
  MedicationSchedule: (p, userId) =>
    p.medicationSchedule.count({ where: { medication: { userId } } }),
  MedicationIntakeEvent: (p, userId) =>
    p.medicationIntakeEvent.count({ where: { userId } }),
  MedicationSideEffect: (p, userId) =>
    p.medicationSideEffect.count({ where: { userId } }),
  MoodEntry: (p, userId) => p.moodEntry.count({ where: { userId } }),
  MoodContext: (p, userId) => p.moodContext.count({ where: { userId } }),
  MoodEntryTagLink: (p, userId) =>
    p.moodEntryTagLink.count({ where: { moodEntry: { userId } } }),
  MoodTag: (p, userId) => p.moodTag.count({ where: { userId } }),
  LabResult: (p, userId) => p.labResult.count({ where: { userId } }),
  Biomarker: (p, userId) => p.biomarker.count({ where: { userId } }),
  Allergy: (p, userId) => p.allergy.count({ where: { userId } }),
  FamilyHistoryEntry: (p, userId) =>
    p.familyHistoryEntry.count({ where: { userId } }),
  IllnessEpisode: (p, userId) => p.illnessEpisode.count({ where: { userId } }),
  IllnessDayLog: (p, userId) => p.illnessDayLog.count({ where: { userId } }),
  IllnessSymptomLink: (p, userId) =>
    p.illnessSymptomLink.count({ where: { dayLog: { userId } } }),
  UserHealthProfile: (p, userId) =>
    p.userHealthProfile.count({ where: { userId } }),
  HealthProfileFactRevision: (p, userId) =>
    p.healthProfileFactRevision.count({ where: { userId } }),
  CycleProfile: (p, userId) => p.cycleProfile.count({ where: { userId } }),
  MenstrualCycle: (p, userId) => p.menstrualCycle.count({ where: { userId } }),
  CycleDayLog: (p, userId) => p.cycleDayLog.count({ where: { userId } }),
  CycleSymptom: (p, userId) => p.cycleSymptom.count({ where: { userId } }),
  CycleSymptomLink: (p, userId) =>
    p.cycleSymptomLink.count({ where: { dayLog: { userId } } }),
  CustomMetric: (p, userId) => p.customMetric.count({ where: { userId } }),
  CustomMetricEntry: (p, userId) =>
    p.customMetricEntry.count({ where: { userId } }),
  CorrelationPattern: (p, userId) =>
    p.correlationPattern.count({ where: { userId } }),
  HealthScoreRecord: (p, userId) =>
    p.healthScoreRecord.count({ where: { userId } }),
  Workout: (p, userId) => p.workout.count({ where: { userId } }),
  NutrientIntakeDay: (p, userId) =>
    p.nutrientIntakeDay.count({ where: { userId } }),
  InboundDocument: (p, userId) =>
    p.inboundDocument.count({ where: { userId } }),
  Practitioner: (p, userId) => p.practitioner.count({ where: { userId } }),
  Encounter: (p, userId) => p.encounter.count({ where: { userId } }),
  EncounterDocumentLink: (p, userId) =>
    p.encounterDocumentLink.count({ where: { userId } }),
  EncounterLabLink: (p, userId) =>
    p.encounterLabLink.count({ where: { userId } }),
  EncounterConditionLink: (p, userId) =>
    p.encounterConditionLink.count({ where: { userId } }),
  VaccinationRecord: (p, userId) =>
    p.vaccinationRecord.count({ where: { userId } }),
  VaccinationDocumentLink: (p, userId) =>
    p.vaccinationDocumentLink.count({ where: { userId } }),
};

/**
 * One row of every two-ended model, for one account.
 *
 * Minimal on purpose: this file asks whether a row survives the round trip, and
 * a fat fixture only makes the answer slower to get. The mood factor and the
 * cycle symptom are the account's OWN custom rows rather than seeded catalogue
 * entries, because a catalogue row survives the account being deleted and would
 * make the link tables look restored when nothing restored them.
 */
async function seedEveryTwoEndedModel(prisma: PrismaClient): Promise<void> {
  await prisma.measurement.create({
    data: {
      userId: OWNER_ID,
      type: "WEIGHT",
      value: 74.2,
      unit: "kg",
      measuredAt: AT("2026-07-01T07:00:00.000Z"),
      source: "MANUAL",
    },
  });
  await prisma.intradayCumulativeProfile.create({
    data: {
      userId: OWNER_ID,
      type: "ACTIVITY_STEPS",
      dateKey: "2026-07-01",
      // One slot per hour — the restore refuses a profile of any other length,
      // because a short row lands in the table and is dropped on read.
      hourlyCumulative: Array.from({ length: 24 }, (_, hour) => hour * 350),
      dayTotal: 8050,
      sampleCount: 24,
      timezone: "Europe/Berlin",
    },
  });

  const medication = await prisma.medication.create({
    data: {
      userId: OWNER_ID,
      name: "Round-trip tablet",
      dose: "5 mg",
      schedules: {
        create: { windowStart: "08:00", windowEnd: "09:00", label: "Morning" },
      },
    },
  });
  await prisma.medicationIntakeEvent.create({
    data: {
      userId: OWNER_ID,
      medicationId: medication.id,
      scheduledFor: AT("2026-07-01T08:00:00.000Z"),
      takenAt: AT("2026-07-01T08:04:00.000Z"),
    },
  });
  // The one row in this fixture that is also checked field by field after the
  // restore — see the assertion at the end of the test for why.
  await prisma.medicationSideEffect.create({
    data: {
      userId: OWNER_ID,
      medicationId: medication.id,
      occurredAt: AT("2026-07-01T21:00:00.000Z"),
      category: "GI",
      entry: "NAUSEA",
      severity: 3,
      notesEncrypted: encryptToBytes(SIDE_EFFECT_NOTE),
    },
  });

  // A RATED tag the account defined itself — the export carries only rated
  // links, so a BINARY tag would leave `MoodEntryTagLink` empty.
  const moodCategory = await prisma.moodTagCategory.findFirstOrThrow({
    where: { userId: null },
  });
  const moodTag = await prisma.moodTag.create({
    data: {
      userId: OWNER_ID,
      categoryId: moodCategory.id,
      key: "round_trip_factor",
      labelKey: "mood.tag.roundTripFactor",
      kind: "RATED",
      scaleMin: 1,
      scaleMax: 5,
    },
  });
  await prisma.moodEntry.create({
    data: {
      userId: OWNER_ID,
      date: "2026-07-01",
      mood: "GUT",
      score: 4,
      source: "MOODLOG",
      moodLoggedAt: AT("2026-07-01T20:00:00.000Z"),
      tagLinks: { create: { moodTagId: moodTag.id, rating: 4 } },
      context: {
        create: {
          userId: OWNER_ID,
          workStatus: "regular",
          contactCircles: JSON.stringify(["family"]),
          leisureJoy: 6,
        },
      },
    },
  });

  const biomarker = await prisma.biomarker.create({
    data: { userId: OWNER_ID, name: "Ferritin", unit: "ng/mL" },
  });
  const labResult = await prisma.labResult.create({
    data: {
      userId: OWNER_ID,
      biomarkerId: biomarker.id,
      analyte: "Ferritin",
      value: 91,
      unit: "ng/mL",
      takenAt: AT("2026-06-30T09:00:00.000Z"),
    },
  });
  await prisma.allergy.create({
    data: { userId: OWNER_ID, substance: "Penicillin" },
  });
  await prisma.familyHistoryEntry.create({
    data: {
      userId: OWNER_ID,
      relationship: "MOTHER",
      condition: "Type 2 diabetes",
    },
  });

  const episode = await prisma.illnessEpisode.create({
    data: {
      userId: OWNER_ID,
      label: "Cold",
      type: "INFECTION",
      onsetAt: AT("2026-06-20T00:00:00.000Z"),
    },
  });
  const illnessSymptom = await prisma.illnessSymptom.create({
    data: { key: "round_trip_cough", labelKey: "illness.symptom.roundTrip" },
  });
  await prisma.illnessDayLog.create({
    data: {
      userId: OWNER_ID,
      episodeId: episode.id,
      date: "2026-06-21",
      symptomLinks: { create: { symptomId: illnessSymptom.id, severity: 2 } },
    },
  });

  await prisma.userHealthProfile.create({
    data: {
      userId: OWNER_ID,
      aboutMeEncrypted: encryptToBytes("Runs three times a week"),
    },
  });
  await prisma.healthProfileFactRevision.create({
    data: {
      userId: OWNER_ID,
      kind: "SMOKING_STATUS",
      valueEncrypted: encryptToBytes("never"),
      validFrom: AT("2026-01-01T00:00:00.000Z"),
    },
  });

  await prisma.cycleProfile.create({
    data: { userId: OWNER_ID, cycleTrackingEnabled: true },
  });
  const cycle = await prisma.menstrualCycle.create({
    data: { userId: OWNER_ID, startDate: "2026-06-01" },
  });
  const cycleCategory = await prisma.cycleSymptomCategory.findFirstOrThrow();
  const cycleSymptom = await prisma.cycleSymptom.create({
    data: {
      userId: OWNER_ID,
      categoryId: cycleCategory.id,
      key: "custom:round-trip-cramps",
      labelKey: "cycle.symptom.custom",
      labelEncrypted: encrypt("Round-trip cramps"),
    },
  });
  await prisma.cycleDayLog.create({
    data: {
      userId: OWNER_ID,
      cycleId: cycle.id,
      date: "2026-06-02",
      flow: "HEAVY",
      symptomLinks: { create: { symptomId: cycleSymptom.id } },
    },
  });

  await prisma.customMetric.create({
    data: {
      userId: OWNER_ID,
      name: "Grip strength",
      unit: "kg",
      entries: {
        create: {
          userId: OWNER_ID,
          value: 44,
          unit: "kg",
          measuredAt: AT("2026-07-01T18:00:00.000Z"),
        },
      },
    },
  });
  await prisma.correlationPattern.create({
    data: {
      userId: OWNER_ID,
      canonicalKey: `p1:${"a1".repeat(32)}`,
      family: "sleep",
      factorKey: "sleep_duration",
      outcomeKey: "weight",
      lagDays: 1,
      sampleSize: 30,
      effectSize: 0.42,
      pValue: 0.01,
      evidenceHash: "b2".repeat(32),
      lastComputedAt: AT("2026-07-01T00:00:00.000Z"),
    },
  });
  await prisma.healthScoreRecord.create({
    data: {
      userId: OWNER_ID,
      dayKey: "2026-07-01",
      timezone: "Europe/Berlin",
      composite: 71,
      band: "green",
      scoreVersion: 1,
      composition: ["activity", "sleep"],
      pillarScores: { activity: 70, sleep: 72 },
      inputFingerprint: "c3".repeat(32),
    },
  });

  await prisma.workout.create({
    data: {
      userId: OWNER_ID,
      sportType: "RUNNING",
      startedAt: AT("2026-06-29T06:00:00.000Z"),
      endedAt: AT("2026-06-29T06:30:00.000Z"),
      durationSec: 1800,
    },
  });
  await prisma.nutrientIntakeDay.create({
    data: {
      userId: OWNER_ID,
      day: "2026-07-01",
      nutrient: "WATER",
      amount: 2100,
      unit: "ml",
      source: "MANUAL",
    },
  });

  const documentBytes = encryptBytes(Buffer.from("round-trip document bytes"));
  const contentEncrypted = new Uint8Array(
    new ArrayBuffer(documentBytes.byteLength),
  );
  contentEncrypted.set(documentBytes);
  const document = await prisma.inboundDocument.create({
    data: {
      userId: OWNER_ID,
      kind: "LAB_RESULT",
      title: "June labs",
      filename: "june-labs.pdf",
      mimeType: "application/pdf",
      byteSize: documentBytes.byteLength,
      contentEncrypted,
      contentCodec: "binary2",
    },
  });

  // One visit, the practice it was at, and one link of each of the three
  // kinds. The links reach the document, the lab result and the condition
  // episode seeded above rather than fresh rows, because a link to something
  // the restore did not put back is the exact case the restore reports as a
  // skip — seeding it against a row that does come back is what makes a
  // returning count mean the filing survived.
  const practitioner = await prisma.practitioner.create({
    data: {
      userId: OWNER_ID,
      name: "Round-trip practice",
      specialty: "Internal medicine",
      noteEncrypted: encryptToBytes("ring the upper bell"),
    },
  });
  const encounter = await prisma.encounter.create({
    data: {
      userId: OWNER_ID,
      occurredAt: AT("2026-06-30T08:00:00.000Z"),
      status: "DONE",
      kind: "ROUTINE",
      practitionerId: practitioner.id,
      reasonEncrypted: encryptToBytes("annual check"),
      outcomeEncrypted: encryptToBytes(
        "ferritin back in range, recheck in a year",
      ),
    },
  });
  await prisma.encounterDocumentLink.create({
    data: {
      userId: OWNER_ID,
      encounterId: encounter.id,
      documentId: document.id,
    },
  });
  await prisma.encounterLabLink.create({
    data: {
      userId: OWNER_ID,
      encounterId: encounter.id,
      labResultId: labResult.id,
    },
  });
  await prisma.encounterConditionLink.create({
    data: {
      userId: OWNER_ID,
      encounterId: encounter.id,
      episodeId: episode.id,
    },
  });

  // One dose with every optional column filled, and the page it was
  // transcribed from. Fat on purpose, against this file's own minimal-fixture
  // rule: a count-back proves the row returned, and the assertion after the
  // restore reads each column back so it also proves the row returned WHOLE.
  // The practitioner and the encounter are the ones seeded above, because both
  // are remapped on the way back and a reference to something the restore did
  // not put back is a different case (covered by the skip test below).
  //
  // `reminderId` is deliberately NOT set here: it is the one reference that
  // can never resolve, so setting it would make this test's "nothing was
  // skipped" assertion false for a reason that is correct behaviour.
  const vaccination = await prisma.vaccinationRecord.create({
    data: {
      userId: OWNER_ID,
      occurredAt: AT("2026-05-14T00:00:00.000Z"),
      antigenSlug: "tdap",
      vaccineName: "Tetanus, diphtheria and pertussis",
      doseNumber: 3,
      seriesDoses: 3,
      lotNumber: "RT-4471",
      site: "LEFT_ARM",
      practitionerId: practitioner.id,
      encounterId: encounter.id,
      noteEncrypted: encryptToBytes("sore arm for a day, nothing else"),
    },
  });
  await prisma.vaccinationDocumentLink.create({
    data: {
      userId: OWNER_ID,
      vaccinationId: vaccination.id,
      documentId: document.id,
    },
  });
}

async function createOwner(prisma: PrismaClient) {
  return prisma.user.create({
    data: {
      id: OWNER_ID,
      username: "round-trip-owner",
      email: "round-trip-owner@example.test",
    },
  });
}

async function seedAdminSession(prisma: PrismaClient) {
  const admin = await prisma.user.create({
    data: {
      username: "round-trip-admin",
      email: "round-trip-admin@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: { userId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return admin;
}

describe("every model the plan claims two-ended survives a real restore", () => {
  it("carries a seeded row of each model out of the account and back in", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await createOwner(prisma);
    await seedEveryTwoEndedModel(prisma);

    // The fixture has to be complete before the account is deleted, or a model
    // seeded with zero rows would come back with zero and read as restored.
    const seeded = await Promise.all(
      TWO_ENDED_MODELS.map(async (model) => [
        model,
        await COUNT_BACK[model](prisma, OWNER_ID),
      ]),
    );
    expect(
      seeded.filter(([, count]) => count === 0).map(([model]) => model),
      "seeded no row for these, so the assertion after the restore would " +
        "compare nothing against nothing and pass",
    ).toEqual([]);

    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });

    // Cascade rather than a hand-listed sweep — see the file comment.
    await prisma.user.delete({ where: { id: OWNER_ID } });
    await createOwner(prisma);
    const emptied = await Promise.all(
      TWO_ENDED_MODELS.map((model) => COUNT_BACK[model](prisma, OWNER_ID)),
    );
    expect(
      emptied.reduce((total, count) => total + count, 0),
      "the account still owns rows after being deleted, so the restore is " +
        "not what put them there",
    ).toBe(0);

    const backup = await prisma.dataBackup.create({
      data: {
        userId: OWNER_ID,
        type: "TWO_ENDED_ROUND_TRIP",
        data: encrypt(JSON.stringify(payload)),
      },
    });
    const response = await POST(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as never,
      { params: Promise.resolve({ id: backup.id }) },
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(
      body.data.skipped.links,
      "a dropped link is a row that did not " +
        "come back, reported rather than silent",
    ).toBe(0);

    const restored = await Promise.all(
      TWO_ENDED_MODELS.map(async (model) => [
        model,
        await COUNT_BACK[model](prisma, OWNER_ID),
      ]),
    );
    expect(
      restored.filter(([, count]) => count === 0).map(([model]) => model),
      "the plan claims these travel both ways; the account was restored " +
        "without them, which is a backup that reports success and hands back " +
        "less than it was given",
    ).toEqual([]);

    const sideEffect = await prisma.medicationSideEffect.findFirstOrThrow({
      where: { userId: OWNER_ID },
      include: { medication: { select: { name: true, userId: true } } },
    });
    expect({
      category: sideEffect.category,
      entry: sideEffect.entry,
      severity: sideEffect.severity,
      occurredAt: sideEffect.occurredAt.toISOString(),
      medication: sideEffect.medication.name,
      medicationOwner: sideEffect.medication.userId,
      note: readNote(sideEffect.notesEncrypted, sideEffect.notes),
    }).toEqual({
      category: "GI",
      entry: "NAUSEA",
      severity: 3,
      occurredAt: "2026-07-01T21:00:00.000Z",
      medication: "Round-trip tablet",
      medicationOwner: OWNER_ID,
      note: SIDE_EFFECT_NOTE,
    });
    // The note must be BACK IN THE COLUMN it came from, not carried as
    // plaintext: a restore that writes a portable export's decrypted note into
    // `notes` reads identically through `readNote` above and has quietly
    // un-encrypted the account's free text.
    expect(sideEffect.notes, "plaintext must not come back in the column").toBe(
      null,
    );

    // The dose, read back column by column. The count above says a row
    // returned; a restore that wrote one row with every optional column
    // defaulted would satisfy it and hand back an Impfpass line with no
    // antigen, no batch code and no arm. The two remapped references are
    // asserted as ids that exist rather than as the ids the file carried,
    // because that is the property the remap owes.
    const dose = await prisma.vaccinationRecord.findFirstOrThrow({
      where: { userId: OWNER_ID },
      include: {
        practitioner: { select: { name: true } },
        encounter: { select: { occurredAt: true } },
        documentLinks: { select: { documentId: true } },
      },
    });
    expect({
      occurredAt: dose.occurredAt.toISOString(),
      antigenSlug: dose.antigenSlug,
      vaccineName: dose.vaccineName,
      doseNumber: dose.doseNumber,
      seriesDoses: dose.seriesDoses,
      lotNumber: dose.lotNumber,
      site: dose.site,
      practitioner: dose.practitioner?.name ?? null,
      encounterAt: dose.encounter?.occurredAt.toISOString() ?? null,
      links: dose.documentLinks.length,
      note: dose.noteEncrypted ? decryptFromBytes(dose.noteEncrypted) : null,
    }).toEqual({
      occurredAt: "2026-05-14T00:00:00.000Z",
      antigenSlug: "tdap",
      vaccineName: "Tetanus, diphtheria and pertussis",
      doseNumber: 3,
      seriesDoses: 3,
      lotNumber: "RT-4471",
      site: "LEFT_ARM",
      practitioner: "Round-trip practice",
      encounterAt: "2026-06-30T08:00:00.000Z",
      links: 1,
      note: "sore arm for a day, nothing else",
    });
  });

  /**
   * The two references a dose can carry that the restore cannot honour, and
   * the slug it must not judge.
   *
   * Separated from the round trip above because both are correct behaviour
   * that shows up as a reported skip, and that file asserts nothing was
   * skipped. Reported is the whole point: a reference dropped in silence is
   * the same defect as a row dropped in silence, one field smaller.
   */
  it("reports the reminder it cannot restore and keeps a slug it cannot resolve", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await createOwner(prisma);

    const reminder = await prisma.measurementReminder.create({
      data: {
        userId: OWNER_ID,
        label: "Tetanus booster",
        intervalDays: 3650,
        vaccinationAntigen: "tetanus",
      },
    });
    await prisma.vaccinationRecord.create({
      data: {
        userId: OWNER_ID,
        occurredAt: AT("1987-09-02T00:00:00.000Z"),
        // A slug no catalogue this release ships resolves. It must come back
        // exactly as written: the renderer degrades to `vaccineName`, and a
        // restore that dropped or rewrote it would lose what a person was
        // actually given.
        antigenSlug: "retired-antigen-from-an-older-release",
        vaccineName: "Whatever the Pass called it in 1987",
        reminderId: reminder.id,
      },
    });

    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });
    await prisma.user.delete({ where: { id: OWNER_ID } });
    await createOwner(prisma);

    const backup = await prisma.dataBackup.create({
      data: {
        userId: OWNER_ID,
        type: "TWO_ENDED_ROUND_TRIP",
        data: encrypt(JSON.stringify(payload)),
      },
    });
    const response = await POST(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as never,
      { params: Promise.resolve({ id: backup.id }) },
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);

    const reported = body.data.skipped.catalogueKeys as Array<{
      catalogue: string;
      key: string;
    }>;
    expect(
      reported.filter((entry) => entry.catalogue === "vaccinationReference"),
      "the reminder the dose pointed at is not in the backup at all, so " +
        "dropping the reference is correct and saying nothing about it is not",
    ).toEqual([
      { catalogue: "vaccinationReference", key: reminder.id, links: 1 },
    ]);

    const dose = await prisma.vaccinationRecord.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    expect({
      antigenSlug: dose.antigenSlug,
      vaccineName: dose.vaccineName,
      reminderId: dose.reminderId,
    }).toEqual({
      antigenSlug: "retired-antigen-from-an-older-release",
      vaccineName: "Whatever the Pass called it in 1987",
      reminderId: null,
    });
  });
});
