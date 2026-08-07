import { beforeEach, describe, expect, it } from "vitest";

import { createManagedProfile } from "@/lib/managed-profiles/create";
import {
  acceptGrant,
  inviteGrant,
  renounceGrant,
  revokeGrant,
} from "@/lib/sharing/grants";

import { getPrismaClient, truncateAllTables } from "./setup";

let sequence = 0;

async function makeAdult(label: string) {
  const suffix = sequence++;
  return getPrismaClient().user.create({
    data: {
      username: `${label}-${suffix}`,
      email: `${label}-${suffix}@example.test`,
    },
  });
}

async function twoGuardians() {
  const creator = await makeAdult("creator");
  const secondGuardian = await makeAdult("second-guardian");
  const { profile, creatorGrant } = await createManagedProfile({
    creatorId: creator.id,
    displayName: "Managed profile",
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  const invitation = await inviteGrant({
    grantorId: profile.id,
    granteeId: secondGuardian.id,
    access: "MANAGE",
    scope: null,
  });
  const secondGrant = await acceptGrant({
    grantId: invitation.id,
    granteeId: secondGuardian.id,
  });
  return { creator, secondGuardian, profile, creatorGrant, secondGrant };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("managed profile Guardian concurrency (real Postgres)", () => {
  it("allows only one concurrent reduction of the final two Guardians", async () => {
    const { creatorGrant, secondGuardian, secondGrant, profile } =
      await twoGuardians();

    const results = await Promise.allSettled([
      revokeGrant({ grantId: creatorGrant.id, grantorId: profile.id }),
      renounceGrant({
        grantId: secondGrant.id,
        granteeId: secondGuardian.id,
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      await getPrismaClient().accountGrant.count({
        where: {
          grantorId: profile.id,
          access: "MANAGE",
          acceptedAt: { not: null },
          revokedAt: null,
        },
      }),
    ).toBe(1);
  });
});
