/**
 * v1.37 — the level-A blocks the assistant actually receives.
 *
 * This calls `extractFeatures`, the shipped composition, against real rows in
 * real Postgres. The unit test beside it (`mood-staleness.test.ts`) rebuilds
 * the block shape from the pure calculator, which proves the calculator and
 * the freshness rule agree — but it never imports `features.ts`, so on its own
 * it would stay green if the builder hardcoded `current: true`, dropped
 * `staleNotice`, or stopped attaching `dimensions` at all. Both ends and the
 * pipe between them: this is the pipe.
 *
 * The fixture is the one the phase exists for. A person taps a face every
 * morning and opens the sliders once a week, so pleasantness is from today and
 * stress is six days old. One of those may back a present-tense sentence and
 * the other may not.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { extractFeatures } from "@/lib/insights/features";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "user-mood-dimension-features";
const TZ = "Europe/Berlin";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The reader's own local today, resolved the way the builder resolves it. */
function todayKey(): string {
  return userDayKey(new Date(), TZ);
}

async function seedUser() {
  await getPrismaClient().user.create({
    data: {
      id: USER,
      username: "mood-dimension-features",
      email: "mood-dimension-features@example.test",
      timezone: TZ,
    },
  });
}

/**
 * One mood entry `daysAgo` days back, carrying whichever level-A values are
 * given. Written through Prisma with every column stated, so the row looks
 * exactly like one a writer would produce.
 */
async function seedEntry(
  daysAgo: number,
  values: {
    mood: string;
    score: number;
    a1?: number | null;
    a2?: number | null;
  },
) {
  const loggedAt = new Date(Date.now() - daysAgo * DAY_MS);
  await getPrismaClient().moodEntry.create({
    data: {
      userId: USER,
      date: shiftDateKey(todayKey(), -daysAgo),
      tz: TZ,
      mood: values.mood,
      score: values.score,
      moodA1: values.a1 ?? null,
      stressA2: values.a2 ?? null,
      source: "MANUAL",
      moodLoggedAt: loggedAt,
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("level-A blocks reach the feature set with their own ages", () => {
  it("marks today's pleasantness current and a six-day-old stress stale", async () => {
    await seedUser();
    // Six days ago: a full entry, sliders and all.
    await seedEntry(6, { mood: "SCHLECHT", score: 2, a1: 3, a2: 9 });
    // Since then, face-only check-ins. Pleasantness keeps moving; stress does
    // not, because nobody opened the section again.
    await seedEntry(2, { mood: "OKAY", score: 3, a1: 5 });
    await seedEntry(0, { mood: "GUT", score: 4, a1: 7 });

    const features = await extractFeatures(USER, false);

    // The block exists at all — a dropped `dimensions` key fails right here.
    expect(features.mood).toBeDefined();
    const dimensions = features.mood?.dimensions;
    expect(
      dimensions,
      "features.mood carries no dimensions block; the assistant would see none of the five",
    ).toBeDefined();

    // Only the two that were answered. A block for a question nobody was
    // asked invites a sentence about it.
    expect(dimensions!.map((d) => d.key).sort()).toEqual(["a1", "a2"]);

    const a1 = dimensions!.find((d) => d.key === "a1")!;
    expect(a1.latest).toBe(7);
    expect(a1.newestDaysAgo).toBe(0);
    expect(a1.current).toBe(true);
    // Nothing to warn about while it is current.
    expect(a1.staleNotice).toBeUndefined();
    expect(a1.count).toBe(3);
    expect(a1.inverse).toBe(false);

    const a2 = dimensions!.find((d) => d.key === "a2")!;
    expect(a2.latest).toBe(9);
    expect(a2.newestDaysAgo).toBe(6);
    // The claim under test: nothing may say "your stress is high today".
    expect(a2.current).toBe(false);
    expect(
      a2.staleNotice,
      "a stale dimension ships without the instruction that makes it safe to read",
    ).toBeTruthy();
    expect(a2.staleNotice).toContain(shiftDateKey(todayKey(), -6));
    expect(a2.staleNotice!.toLowerCase()).toContain("do not describe");
    // Stored literally: stress is inverse-oriented and says so rather than
    // arriving pre-flipped.
    expect(a2.inverse).toBe(true);
    expect(a2.count).toBe(1);

    // The block-level asOf the snapshot stamps on top of this comes from
    // coverage.newestDaysAgo — the newest ENTRY, which is today, because a
    // face was tapped this morning. Read as covering the dimensions it would
    // make the six-day-old stress look current, so the block says which age
    // governs which claim.
    expect(features.mood?.coverage.newestDaysAgo).toBe(0);
    expect(
      features.mood?.dimensionsAsOfNote,
      "the block carries two ages that disagree and nothing says which one governs the dimensions",
    ).toBeTruthy();
    expect(features.mood?.dimensionsAsOfNote).toContain("newestDaysAgo");
  });

  it("never ships a latest without an age beside it, and names the scale", async () => {
    await seedUser();
    await seedEntry(1, { mood: "GUT", score: 4, a1: 8, a2: 2 });

    const features = await extractFeatures(USER, false);
    const dimensions = features.mood?.dimensions ?? [];
    expect(dimensions.length).toBeGreaterThan(0);

    for (const block of dimensions) {
      expect(block.latest).not.toBeNull();
      // The structural half of the fix: a `latest` with no age is exactly
      // what produced a reading from last week stated as this morning's.
      expect(block.newestDaysAgo).not.toBeNull();
      expect(block.latestDate).not.toBeNull();
      expect(typeof block.current).toBe("boolean");
      // And the wording behind the numbers, so a 7 is not read as 7 out of 5.
      expect(block.scale).toMatch(/0-10/);
      expect(block.scale.length).toBeGreaterThan(20);
    }

    // Yesterday still backs a present-tense claim.
    expect(dimensions.every((d) => d.current)).toBe(true);
  });

  it("omits the block entirely for an account that has only ever tapped a face", async () => {
    await seedUser();
    // Rows written before the columns existed look exactly like this.
    await seedEntry(0, { mood: "GUT", score: 4 });

    const features = await extractFeatures(USER, false);
    // The mood aggregate is still there — the five-point axis is unaffected.
    expect(features.mood).toBeDefined();
    expect(features.mood?.latest).toBe(4);
    // But nothing claims a self-state that was never recorded — and no note
    // explaining a block that is not there.
    expect(features.mood?.dimensions).toBeUndefined();
    expect(features.mood?.dimensionsAsOfNote).toBeUndefined();
  });

  it("carries the day's forecast with its own age, and its own instruction", async () => {
    await seedUser();
    await seedEntry(0, { mood: "GUT", score: 4, a1: 7, a2: 3 });
    // A forecast about the day before yesterday. Written straight to the
    // table: the job's own path is proven in `mood-prognosis-ladder.test.ts`,
    // and what this case is about is what the assistant is handed.
    await getPrismaClient().moodPrediction.create({
      data: {
        userId: USER,
        date: shiftDateKey(todayKey(), -3),
        predicted: 5.4,
        ciLow: 4.1,
        ciHigh: 6.8,
        n: 42,
        modelVersion: "mood-ridge-1",
        features: JSON.stringify([
          { feature: "dimension:a2", contribution: 0.9 },
        ]),
        computedAt: new Date(Date.now() - 3 * DAY_MS),
      },
    });

    const features = await extractFeatures(USER, false);
    const prognosis = features.mood?.prognosis;
    expect(
      prognosis,
      "features.mood carries no prognosis block; the assistant sees neither the value nor the fact that there is none",
    ).toBeDefined();
    expect(prognosis!.present).toBe(true);
    expect(prognosis!.predicted).toBe(5.4);
    expect(prognosis!.n).toBe(42);
    expect(prognosis!.ciLow).toBe(4.1);
    expect(prognosis!.ciHigh).toBe(6.8);
    // Three days old: the same freshness rule the dimensions use, from the
    // same module, so nothing may state it as today.
    expect(prognosis!.daysAgo).toBe(3);
    expect(prognosis!.current).toBe(false);
    expect(
      prognosis!.staleNotice,
      "a stale forecast ships without the instruction that makes it safe to read",
    ).toBeTruthy();
    expect(prognosis!.staleNotice).toContain(shiftDateKey(todayKey(), -3));
    expect(prognosis!.staleNotice!.toLowerCase()).toContain("do not describe");
    // And the wording rule rides with the values rather than being inferred.
    expect(prognosis!.note.toLowerCase()).toContain("counterfactual");
    expect(prognosis!.note.toLowerCase()).toContain("never merge");
  });

  it("states the absence of a forecast rather than omitting it", async () => {
    await seedUser();
    await seedEntry(0, { mood: "GUT", score: 4, a1: 7 });

    const features = await extractFeatures(USER, false);
    const prognosis = features.mood?.prognosis;
    expect(prognosis).toBeDefined();
    // Absence is a field, not a missing key: a model told "there is none yet"
    // says so, and a model told nothing estimates one.
    expect(prognosis!.present).toBe(false);
    expect(prognosis!.reason).toBe("no-output-yet");
    expect(prognosis!.entries).toBe(1);
    expect(prognosis!.predicted).toBeUndefined();
  });

  it("leaves the legacy scale line untouched", async () => {
    await seedUser();
    await seedEntry(0, { mood: "GUT", score: 4, a1: 7 });

    const features = await extractFeatures(USER, false);
    // Sent to the model verbatim and describing `score`, not the new axis.
    // A phase that widened this string would have changed a sentence the
    // model has been reading correctly for years.
    expect(features.mood?.scale).toBe(
      "1=LAUSIG, 2=SCHLECHT, 3=OKAY, 4=GUT, 5=SUPER_GUT",
    );
  });
});
