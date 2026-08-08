/**
 * v1.38 — the linked day block, proven against real Postgres to be a read of
 * the owning module rather than a copy of it.
 *
 * The claim the whole design rests on cannot be made by a shape test. "The
 * response has a `sleep` key" would stay green over an implementation that
 * copied the figure onto the mood row at write time and never looked at it
 * again — and that implementation is exactly the failure mode this feature
 * exists to avoid. So the test changes the SOURCE and reads the mood surface
 * again: write a sleep session, read the block, correct the session, read
 * again, assert the block moved.
 *
 * Beside it, the two absences that are easy to get wrong:
 *   - a module switched off blanks its block rather than answering zero;
 *   - a day with no rows answers `{ present: false }`, which is a different
 *     fact from a day of no sleep.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-mood-linkage";
const DAY = "2026-06-11";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "mood-linkage",
      email: "mood-linkage@example.test",
      timezone: "Europe/Berlin",
    },
  });
  const session = await getPrismaClient().session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

interface LinkedFigure {
  present: boolean;
  value?: number;
  unit?: string;
}
interface LinkedBody {
  available: boolean;
  reason?: string;
  day: string;
  sleep: { available: boolean; asleep?: LinkedFigure; inBed?: LinkedFigure };
  activity: {
    available: boolean;
    reason?: string;
    steps?: LinkedFigure;
    activeEnergy?: LinkedFigure;
  };
  vitals: {
    available: boolean;
    restingHeartRate?: LinkedFigure;
    heartRateVariability?: LinkedFigure;
  };
  body: {
    available: boolean;
    reason?: string;
    logged?: boolean;
    symptoms?: string[];
    episodeId?: string | null;
  };
}

async function readLinked(day = DAY): Promise<LinkedBody> {
  const { GET } = await import("@/app/api/mood/linked-context/route");
  const res = await GET(
    new NextRequest(
      `http://localhost/api/mood/linked-context?date=${day}&tz=Europe%2FBerlin`,
    ),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: LinkedBody };
  return body.data;
}

/** One night's sleep, as the sleep module stores it: minutes per stage. */
async function writeSleep(minutes: number) {
  return getPrismaClient().measurement.create({
    data: {
      userId: TEST_USER_ID,
      type: "SLEEP_DURATION",
      value: minutes,
      unit: "min",
      // A night that ends on the morning of DAY: the reconstruction keys a
      // night on the day it woke up on.
      measuredAt: new Date("2026-06-11T05:30:00.000Z"),
      sleepStage: "ASLEEP",
      source: "MANUAL",
    },
  });
}

describe("mood context linkage (real Postgres)", () => {
  it("a corrected sleep session moves the linked figure, because nothing was copied", async () => {
    const row = await writeSleep(400);

    const before = await readLinked();
    expect(before.sleep.available).toBe(true);
    expect(before.sleep.asleep).toEqual({
      present: true,
      value: 400,
      unit: "min",
    });

    // The correction, made where the fact lives.
    await getPrismaClient().measurement.update({
      where: { id: row.id },
      data: { value: 455 },
    });

    const after = await readLinked();
    expect(after.sleep.asleep).toEqual({
      present: true,
      value: 455,
      unit: "min",
    });
  });

  it("a day with no rows answers absence, not zero", async () => {
    const linked = await readLinked();
    expect(linked.sleep.available).toBe(true);
    expect(linked.sleep.asleep).toEqual({ present: false });
    expect(linked.activity.steps).toEqual({ present: false });
    expect(linked.vitals.restingHeartRate).toEqual({ present: false });
    // Never a zero: a night nobody recorded and a night of no sleep are
    // different facts, and only one of them belongs in a health record.
    expect(JSON.stringify(linked)).not.toContain('"value":0');
  });

  it("sums the day's activity and takes the day's latest vital", async () => {
    await getPrismaClient().measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 4000,
          unit: "steps",
          measuredAt: new Date("2026-06-11T08:00:00.000Z"),
          source: "MANUAL",
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 2500,
          unit: "steps",
          measuredAt: new Date("2026-06-11T18:00:00.000Z"),
          source: "MANUAL",
        },
        {
          userId: TEST_USER_ID,
          type: "RESTING_HEART_RATE",
          value: 61,
          unit: "bpm",
          measuredAt: new Date("2026-06-11T07:00:00.000Z"),
          source: "MANUAL",
        },
        {
          userId: TEST_USER_ID,
          type: "RESTING_HEART_RATE",
          value: 58,
          unit: "bpm",
          measuredAt: new Date("2026-06-11T21:00:00.000Z"),
          source: "MANUAL",
        },
        // The day before, to prove the window does not bleed.
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 9999,
          unit: "steps",
          measuredAt: new Date("2026-06-10T12:00:00.000Z"),
          source: "MANUAL",
        },
      ],
    });

    const linked = await readLinked();
    expect(linked.activity.steps).toEqual({
      present: true,
      value: 6500,
      unit: "steps",
    });
    expect(linked.vitals.restingHeartRate).toEqual({
      present: true,
      value: 58,
      unit: "bpm",
    });
  });

  it("blanks the sleep block when the sleep module is off, rather than answering zero", async () => {
    await writeSleep(400);
    expect((await readLinked()).sleep.available).toBe(true);

    await getPrismaClient().user.update({
      where: { id: TEST_USER_ID },
      data: { modulePreferencesJson: { sleep: false } },
    });

    const linked = await readLinked();
    expect(linked.sleep).toEqual({
      available: false,
      reason: "module-disabled",
    });
    // The block is gone, not zeroed and not filtered down to an empty figure.
    expect(linked.sleep).not.toHaveProperty("asleep");
    // And the other blocks are untouched by that choice.
    expect(linked.activity.available).toBe(true);
    expect(linked.vitals.available).toBe(true);
  });

  it("links the illness day-log read-only, and blanks it when the module is off", async () => {
    const episode = await getPrismaClient().illnessEpisode.create({
      data: {
        userId: TEST_USER_ID,
        label: "cold",
        type: "INFECTION",
        onsetAt: new Date("2026-06-10T08:00:00.000Z"),
      },
    });
    // The symptom catalogue is seeded reference data every instance has, so
    // this upserts rather than creating: the point of the test is the link,
    // not the row.
    const symptom = await getPrismaClient().illnessSymptom.upsert({
      where: { key: "cough" },
      create: { key: "cough", labelKey: "illness.symptom.cough" },
      update: {},
    });
    await getPrismaClient().illnessDayLog.create({
      data: {
        userId: TEST_USER_ID,
        episodeId: episode.id,
        date: DAY,
        functionalImpact: 2,
        symptomLinks: { create: [{ symptomId: symptom.id, severity: 2 }] },
      },
    });

    const linked = await readLinked();
    expect(linked.body.available).toBe(true);
    expect(linked.body.logged).toBe(true);
    expect(linked.body.symptoms).toEqual(["cough"]);
    expect(linked.body.episodeId).toBe(episode.id);

    await getPrismaClient().user.update({
      where: { id: TEST_USER_ID },
      data: { modulePreferencesJson: { illness: false } },
    });
    expect((await readLinked()).body).toEqual({
      available: false,
      reason: "module-disabled",
    });
  });

  it("refuses a malformed day", async () => {
    const { GET } = await import("@/app/api/mood/linked-context/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/mood/linked-context?date=yesterday",
      ),
    );
    expect(res.status).toBe(422);
  });
});
