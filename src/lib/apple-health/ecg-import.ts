/**
 * Persistence for one normalized Apple Health ECG recording out of an
 * `export.zip`.
 *
 * The stable identity is derived from canonical recording content, never the
 * archive filename, so the same strip re-imported under a different filename
 * deduplicates. The database uniqueness constraint adds the user boundary, so
 * identical recordings deduplicate for one user while remaining independent
 * across tenants.
 *
 * The write itself lives in `@/lib/ecg/persist-recording`, shared with the
 * live `POST /api/insights/ecg` ingest and the Withings sync. That is also
 * where the second identity — `(userId, source, recordedAt,
 * samplingFrequency)` — is honoured: a strip already stored from the live
 * sync under its device sample uuid reports `skipped` here rather than
 * landing a second time under its content hash.
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { NormalizedAppleHealthEcg } from "@/lib/apple-health/ecg-csv";
import { persistEcgRecording } from "@/lib/ecg/persist-recording";

export type AppleHealthEcgImportOutcome = "imported" | "updated" | "skipped";

function recordingIdentity(ecg: NormalizedAppleHealthEcg): string {
  const hash = createHash("sha256");
  hash.update("healthlog:apple-health-ecg:v1\0");
  hash.update(ecg.recordedAt.toISOString());
  hash.update(`\0${ecg.samplingFrequency}\0${ecg.lead ?? ""}`);
  hash.update(
    `\0${ecg.averageHeartRate ?? ""}\0${ecg.rhythmClassification ?? ""}\0`,
  );
  const sample = Buffer.allocUnsafe(8);
  for (const value of ecg.samples) {
    sample.writeDoubleLE(value, 0);
    hash.update(sample);
  }
  sample.fill(0);
  return `apple-health:ecg:${hash.digest("hex")}`;
}

export async function importAppleHealthEcg(input: {
  userId: string;
  ecg: NormalizedAppleHealthEcg;
  prisma: Pick<PrismaClient, "$transaction">;
}): Promise<AppleHealthEcgImportOutcome> {
  const { userId, ecg, prisma } = input;
  if (ecg.samples.length === 0) return "skipped";

  const result = await persistEcgRecording(
    {
      userId,
      source: "APPLE_HEALTH",
      externalRecordingId: recordingIdentity(ecg),
      recordedAt: ecg.recordedAt,
      samples: ecg.samples,
      samplingFrequency: ecg.samplingFrequency,
      lead: ecg.lead,
      averageHeartRate: ecg.averageHeartRate,
      rhythmClassification: ecg.rhythmClassification,
    },
    prisma,
  );

  if (result.outcome === "inserted") return "imported";
  // The live ingest already holds this strip under its device sample uuid.
  // Nothing was written and nothing was lost.
  if (result.outcome === "duplicate") return "skipped";
  return "updated";
}
