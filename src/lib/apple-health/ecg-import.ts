/**
 * Transactional persistence for one normalized Apple Health ECG recording.
 *
 * The stable identity is derived from canonical recording content, never the
 * archive filename. The database uniqueness constraint adds the user boundary,
 * so identical recordings deduplicate for one user while remaining independent
 * across tenants.
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { NormalizedAppleHealthEcg } from "@/lib/apple-health/ecg-csv";
import { encryptWaveformToBytes } from "@/lib/withings/ecg-waveform-codec";

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

  const externalRecordingId = recordingIdentity(ecg);
  // Encryption is deliberately completed before entering the transaction.
  // Crypto failure therefore fails closed without opening a write transaction.
  const waveformEncrypted = encryptWaveformToBytes(ecg.samples);
  const sampleCount = ecg.samples.length;
  const durationSeconds = sampleCount / ecg.samplingFrequency;

  try {
    return await prisma.$transaction(async (tx) => {
      const where = {
        userId_source_externalRecordingId: {
          userId,
          source: "APPLE_HEALTH" as const,
          externalRecordingId,
        },
      };
      const existing = await tx.ecgRecording.findUnique({
        where,
        select: { id: true },
      });
      await tx.ecgRecording.upsert({
        where,
        create: {
          userId,
          source: "APPLE_HEALTH",
          externalRecordingId,
          recordedAt: ecg.recordedAt,
          waveformEncrypted,
          samplingFrequency: ecg.samplingFrequency,
          sampleCount,
          durationSeconds,
          lead: ecg.lead,
          averageHeartRate: ecg.averageHeartRate,
          rhythmClassification: ecg.rhythmClassification,
        },
        update: {
          recordedAt: ecg.recordedAt,
          waveformEncrypted,
          samplingFrequency: ecg.samplingFrequency,
          sampleCount,
          durationSeconds,
          lead: ecg.lead,
          averageHeartRate: ecg.averageHeartRate,
          rhythmClassification: ecg.rhythmClassification,
        },
      });
      return existing ? "updated" : "imported";
    });
  } finally {
    waveformEncrypted.fill(0);
    ecg.samples.fill(0);
  }
}
