import { Buffer } from "node:buffer";

import { beforeEach, describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { restoreProfileData } from "@/lib/export/profile-backup";
import { parseBackupPayload } from "@/lib/validations/backup";
import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function seedProfile() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "profile-roundtrip",
      email: "profile-roundtrip@example.test",
      role: "USER",
    },
  });
  const emergencyContactsCiphertext = encryptToBytes(
    "ICE contact, reachable on the recorded number",
  );
  await prisma.userHealthProfile.create({
    data: {
      id: "profile-roundtrip-row",
      userId: user.id,
      aboutMeEncrypted: encryptToBytes("Works rotating shifts"),
      conditionsEncrypted: encryptToBytes("Asthma"),
      aiIncludedSections: ["CONDITIONS", "SMOKING_STATUS", "SHIFT_SCHEDULE"],
      // Emergency profile: three plaintext enums + three encrypted columns.
      emergencyBloodType: "O_NEG",
      organDonorStatus: "YES",
      advanceDirectiveStatus: "EXISTS",
      emergencyContactsEncrypted: emergencyContactsCiphertext,
      emergencyImplantsEncrypted: encryptToBytes("Pacemaker fitted 2021"),
      emergencyNoteEncrypted: encryptToBytes("Reacts to contrast dye"),
    },
  });

  const currentCiphertext = encryptToBytes("FORMER");
  await prisma.healthProfileFactRevision.create({
    data: {
      id: "smoking-current",
      userId: user.id,
      kind: "SMOKING_STATUS",
      valueEncrypted: currentCiphertext,
      validFrom: new Date("2026-07-10T00:00:00.000Z"),
      provenance: "USER_CORRECTION",
    },
  });
  await prisma.healthProfileFactRevision.create({
    data: {
      id: "smoking-prior",
      userId: user.id,
      kind: "SMOKING_STATUS",
      valueEncrypted: encryptToBytes("CURRENT"),
      validFrom: new Date("2026-07-01T00:00:00.000Z"),
      validUntil: new Date("2026-07-10T00:00:00.000Z"),
      provenance: "USER_REPORTED",
      supersededByRevisionId: "smoking-current",
    },
  });
  await prisma.healthProfileFactRevision.create({
    data: {
      id: "shift-current",
      userId: user.id,
      kind: "SHIFT_SCHEDULE",
      valueEncrypted: encryptToBytes("ROTATING"),
      validFrom: new Date("2026-07-05T00:00:00.000Z"),
      provenance: "USER_REPORTED",
    },
  });

  return { user, currentCiphertext, emergencyContactsCiphertext };
}

describe("health profile disaster-recovery round trip", () => {
  it("restores deleted encrypted profile rows and effective-dated history", async () => {
    const prisma = getPrismaClient();
    const { user, currentCiphertext, emergencyContactsCiphertext } =
      await seedProfile();
    const built = await buildFullBackupPayload(prisma, user.id, {
      purpose: "disaster-recovery",
    });
    const payload = parseBackupPayload(
      JSON.parse(JSON.stringify(built.payload)),
    );

    expect(payload.healthProfileFacts).toHaveLength(3);
    expect(
      payload.healthProfileFacts.every((fact) => fact.value === null),
    ).toBe(true);
    expect(
      payload.healthProfileFacts.every(
        (fact) => typeof fact.valueEncrypted === "string",
      ),
    ).toBe(true);

    await prisma.healthProfileFactRevision.deleteMany({
      where: { userId: user.id },
    });
    await prisma.userHealthProfile.deleteMany({ where: { userId: user.id } });
    expect(
      await prisma.healthProfileFactRevision.count({
        where: { userId: user.id },
      }),
    ).toBe(0);
    expect(
      await prisma.userHealthProfile.count({ where: { userId: user.id } }),
    ).toBe(0);

    await prisma.$transaction((tx) => restoreProfileData(tx, user.id, payload));

    const profile = await prisma.userHealthProfile.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(profile.aiIncludedSections).toEqual([
      "CONDITIONS",
      "SMOKING_STATUS",
      "SHIFT_SCHEDULE",
    ]);

    // Every emergency column has to survive the round trip. The three enums
    // come back by value; the three encrypted columns come back as ciphertext,
    // and the contact column decrypts to exactly what was seeded. Dropping any
    // one of the six from the profile backup builder turns the matching
    // assertion red naming that column.
    expect(profile.emergencyBloodType).toBe("O_NEG");
    expect(profile.organDonorStatus).toBe("YES");
    expect(profile.advanceDirectiveStatus).toBe("EXISTS");
    expect(profile.emergencyContactsEncrypted).not.toBeNull();
    expect(profile.emergencyImplantsEncrypted).not.toBeNull();
    expect(profile.emergencyNoteEncrypted).not.toBeNull();
    expect(Buffer.from(profile.emergencyContactsEncrypted!)).toEqual(
      Buffer.from(emergencyContactsCiphertext),
    );

    const revisions = await prisma.healthProfileFactRevision.findMany({
      where: { userId: user.id },
      orderBy: { validFrom: "asc" },
    });
    expect(revisions).toHaveLength(3);
    const prior = revisions.find((row) => row.id === "smoking-prior");
    const current = revisions.find((row) => row.id === "smoking-current");
    expect(prior?.validUntil).toEqual(new Date("2026-07-10T00:00:00.000Z"));
    expect(prior?.supersededByRevisionId).toBe("smoking-current");
    expect(current?.validUntil).toBeNull();
    expect(Buffer.from(current!.valueEncrypted)).toEqual(
      Buffer.from(currentCiphertext),
    );
  });

  it("cascades every profile revision when the account is deleted", async () => {
    const prisma = getPrismaClient();
    const { user } = await seedProfile();

    await prisma.user.delete({ where: { id: user.id } });

    expect(
      await prisma.healthProfileFactRevision.count({
        where: { userId: user.id },
      }),
    ).toBe(0);
    expect(
      await prisma.userHealthProfile.count({ where: { userId: user.id } }),
    ).toBe(0);
  });
});
