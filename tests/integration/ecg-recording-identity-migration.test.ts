/**
 * Migration `0291_ecg_recording_identity` against a table that ALREADY holds
 * colliding rows.
 *
 * The testcontainer starts empty, so applying this migration during global
 * setup proves nothing about the deployed instances it will actually run on:
 * two writers have been filling `ecg_recordings` since v1.19.0, and a unique
 * index that meets a pre-existing duplicate aborts the migration on boot. So
 * this test drops the index, manufactures the collisions the resolution step
 * exists for, and runs the REAL migration file through the Prisma CLI — the
 * same executor `db:migrate:deploy` uses — then checks which row survived and
 * that the constraint is live afterwards.
 */
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const MIGRATION_FILE = join(
  PROJECT_ROOT,
  "prisma",
  "migrations",
  "0291_ecg_recording_identity",
  "migration.sql",
);
const INDEX_NAME = "ecg_recordings_user_source_recorded_at_freq_key";

const USER_ID = "ecg-identity-migration";

function applyMigration(): void {
  // Same executor and same connection `db:migrate:deploy` uses; the URL comes
  // from the child environment exactly as it does for the real deploy.
  execFileSync(
    "pnpm",
    ["exec", "prisma", "db", "execute", "--file", MIGRATION_FILE],
    {
      cwd: PROJECT_ROOT,
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    },
  );
}

async function dropIndex(): Promise<void> {
  await getPrismaClient().$executeRawUnsafe(
    `DROP INDEX IF EXISTS "${INDEX_NAME}"`,
  );
}

async function indexExists(): Promise<boolean> {
  const rows = await getPrismaClient().$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'ecg_recordings' AND indexname = ${INDEX_NAME}
  `;
  return rows.length === 1;
}

/**
 * Insert a row directly. `waveform_encrypted` is opaque to the migration, so
 * a marker byte string is enough and keeps the fixture honest about what the
 * migration does and does not read.
 */
async function insertRecording(input: {
  id: string;
  externalRecordingId: string;
  recordedAt: string;
  samplingFrequency: number;
  sampleCount: number;
  measurementId?: string | null;
  updatedAt: string;
}): Promise<void> {
  await getPrismaClient().$executeRawUnsafe(
    `INSERT INTO ecg_recordings
       (id, user_id, source, external_recording_id, recorded_at,
        waveform_encrypted, sampling_frequency, sample_count, duration_seconds,
        measurement_id, created_at, updated_at)
     VALUES ($1, $2, 'APPLE_HEALTH', $3, $4::timestamptz, $5, $6, $7, $8, $9,
             $10::timestamptz, $10::timestamptz)`,
    input.id,
    USER_ID,
    input.externalRecordingId,
    input.recordedAt,
    Buffer.from(`ciphertext-${input.id}`, "utf8"),
    input.samplingFrequency,
    input.sampleCount,
    input.sampleCount / input.samplingFrequency,
    input.measurementId ?? null,
    input.updatedAt,
  );
}

async function createMeasurement(
  id: string,
  measuredAt: string,
): Promise<string> {
  const row = await getPrismaClient().measurement.create({
    data: {
      id,
      userId: USER_ID,
      type: "IRREGULAR_RHYTHM_NOTIFICATION",
      value: 1,
      unit: "event",
      measuredAt: new Date(measuredAt),
      source: "APPLE_HEALTH",
    },
    select: { id: true },
  });
  return row.id;
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "ecg-identity-migration",
      email: "ecg-identity-migration@example.test",
      timezone: "UTC",
    },
  });
});

afterEach(async () => {
  // Whatever this test did to the schema, the next file gets the migrated one.
  if (!(await indexExists())) applyMigration();
});

describe("0291_ecg_recording_identity against a table that already has duplicates", () => {
  it("resolves the duplicates, keeps the canonical row, and leaves the index enforcing", async () => {
    const prisma = getPrismaClient();
    await dropIndex();
    expect(await indexExists()).toBe(false);

    const eventId = await createMeasurement(
      "ecg-identity-event-1",
      "2026-07-18T06:14:03.000Z",
    );

    // Partition 1 — the same recording under two source ids. The richer strip
    // has no event link; the thin one does, and its link must survive.
    await insertRecording({
      id: "p1-keeper-more-samples",
      externalRecordingId: "apple-health:ecg:content-hash",
      recordedAt: "2026-07-18T06:14:03Z",
      samplingFrequency: 512,
      sampleCount: 15_360,
      updatedAt: "2026-07-18T07:00:00Z",
    });
    await insertRecording({
      id: "p1-loser-fewer-samples",
      externalRecordingId: "8E1F3B0C-0000-4000-8000-000000000001",
      recordedAt: "2026-07-18T06:14:03Z",
      samplingFrequency: 512,
      sampleCount: 12,
      measurementId: eventId,
      updatedAt: "2026-07-18T09:00:00Z",
    });

    // Partition 2 — equal strips, one linked to its event row.
    await insertRecording({
      id: "p2-unlinked",
      externalRecordingId: "p2-a",
      recordedAt: "2026-07-19T06:14:03Z",
      samplingFrequency: 512,
      sampleCount: 512,
      updatedAt: "2026-07-19T09:00:00Z",
    });
    const secondEventId = await createMeasurement(
      "ecg-identity-event-2",
      "2026-07-19T06:14:03.000Z",
    );
    await insertRecording({
      id: "p2-linked",
      externalRecordingId: "p2-b",
      recordedAt: "2026-07-19T06:14:03Z",
      samplingFrequency: 512,
      sampleCount: 512,
      measurementId: secondEventId,
      updatedAt: "2026-07-19T07:00:00Z",
    });

    // Partition 3 — indistinguishable but for when they were last written.
    await insertRecording({
      id: "p3-stale",
      externalRecordingId: "p3-a",
      recordedAt: "2026-07-20T06:14:03Z",
      samplingFrequency: 512,
      sampleCount: 512,
      updatedAt: "2026-07-20T07:00:00Z",
    });
    await insertRecording({
      id: "p3-fresh",
      externalRecordingId: "p3-b",
      recordedAt: "2026-07-20T06:14:03Z",
      samplingFrequency: 512,
      sampleCount: 512,
      updatedAt: "2026-07-20T09:00:00Z",
    });

    // A recording that collides with nothing must be left exactly as it is.
    await insertRecording({
      id: "p4-untouched",
      externalRecordingId: "p4-a",
      recordedAt: "2026-07-21T06:14:03Z",
      samplingFrequency: 512,
      sampleCount: 512,
      updatedAt: "2026-07-21T07:00:00Z",
    });

    expect(await prisma.ecgRecording.count()).toBe(7);

    applyMigration();

    expect(await indexExists()).toBe(true);
    const survivors = await prisma.ecgRecording.findMany({
      orderBy: { recordedAt: "asc" },
      select: { id: true, measurementId: true, externalRecordingId: true },
    });
    expect(survivors.map((row) => row.id)).toEqual([
      "p1-keeper-more-samples",
      "p2-linked",
      "p3-fresh",
      "p4-untouched",
    ]);
    // The loser's event link was salvaged onto the keeper.
    expect(survivors[0].measurementId).toBe(eventId);
    expect(survivors[1].measurementId).toBe(secondEventId);
    expect(survivors[3].externalRecordingId).toBe("p4-a");

    // The event rows themselves are untouched — resolving a duplicate
    // recording never deletes a measurement.
    expect(await prisma.measurement.count({ where: { userId: USER_ID } })).toBe(
      2,
    );

    // And the constraint is live: the collision cannot come back.
    await expect(
      insertRecording({
        id: "post-migration-twin",
        externalRecordingId: "another-id-entirely",
        recordedAt: "2026-07-21T06:14:03Z",
        samplingFrequency: 512,
        sampleCount: 512,
        updatedAt: "2026-07-21T10:00:00Z",
      }),
    ).rejects.toThrow();
    expect(await prisma.ecgRecording.count()).toBe(4);
  });

  it("leaves rows alone that only look alike across users, sources or sampling rates", async () => {
    const prisma = getPrismaClient();
    await dropIndex();
    const otherUser = await prisma.user.create({
      data: {
        username: "ecg-identity-migration-other",
        email: "ecg-identity-migration-other@example.test",
      },
    });

    await insertRecording({
      id: "same-instant-apple",
      externalRecordingId: "a",
      recordedAt: "2026-07-18T06:14:03Z",
      samplingFrequency: 512,
      sampleCount: 512,
      updatedAt: "2026-07-18T07:00:00Z",
    });
    // Same instant, different sampling rate — a different recording.
    await insertRecording({
      id: "same-instant-other-rate",
      externalRecordingId: "b",
      recordedAt: "2026-07-18T06:14:03Z",
      samplingFrequency: 300,
      sampleCount: 300,
      updatedAt: "2026-07-18T07:00:00Z",
    });
    // Same instant and rate, but a different source.
    await prisma.$executeRawUnsafe(
      `INSERT INTO ecg_recordings
         (id, user_id, source, external_recording_id, recorded_at,
          waveform_encrypted, sampling_frequency, sample_count, created_at, updated_at)
       VALUES ('same-instant-withings', $1, 'WITHINGS', 'c',
               '2026-07-18T06:14:03Z'::timestamptz, $2, 512, 512, NOW(), NOW())`,
      USER_ID,
      Buffer.from("ciphertext-withings", "utf8"),
    );
    // Same instant and rate, but somebody else's account.
    await prisma.$executeRawUnsafe(
      `INSERT INTO ecg_recordings
         (id, user_id, source, external_recording_id, recorded_at,
          waveform_encrypted, sampling_frequency, sample_count, created_at, updated_at)
       VALUES ('same-instant-other-user', $1, 'APPLE_HEALTH', 'd',
               '2026-07-18T06:14:03Z'::timestamptz, $2, 512, 512, NOW(), NOW())`,
      otherUser.id,
      Buffer.from("ciphertext-other-user", "utf8"),
    );

    applyMigration();

    expect(await indexExists()).toBe(true);
    const ids = (
      await prisma.ecgRecording.findMany({ select: { id: true } })
    ).map((row) => row.id);
    expect(ids.sort()).toEqual(
      [
        "same-instant-apple",
        "same-instant-other-rate",
        "same-instant-other-user",
        "same-instant-withings",
      ].sort(),
    );
  });
});
