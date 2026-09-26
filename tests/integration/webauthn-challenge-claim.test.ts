/**
 * A WebAuthn challenge is good for exactly one verification.
 *
 * The ceremony verifiers used to read the challenge, verify, and delete it
 * afterwards, so two requests carrying the same assertion could both read it
 * and both pass. `claimAuthChallenge` deletes and returns it in one guarded
 * statement; this pins that against real Postgres.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const { claimAuthChallenge } = await import("@/lib/auth/passkey");

const USER_ID = "user-challenge-claim";

async function challenge(
  type: string,
  opts: { userId?: string | null; expiresInMs?: number } = {},
): Promise<string> {
  const row = await getPrismaClient().authChallenge.create({
    data: {
      userId: opts.userId === undefined ? USER_ID : opts.userId,
      challenge: `material-${type}`,
      type,
      expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 60_000)),
    },
  });
  return row.id;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "claim-user",
      email: "claim@example.test",
    },
  });
});

describe("claimAuthChallenge", () => {
  it("hands the challenge to exactly one of two concurrent claims", async () => {
    const id = await challenge("authentication");
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimAuthChallenge({ challengeId: id, type: "authentication" }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await getPrismaClient().authChallenge.count({ where: { id } })).toBe(
      0,
    );
  });

  it("returns the material and the account it was begun for", async () => {
    const id = await challenge("mfa_authentication");
    await expect(
      claimAuthChallenge({
        challengeId: id,
        type: "mfa_authentication",
        userId: USER_ID,
      }),
    ).resolves.toEqual({
      challenge: "material-mfa_authentication",
      userId: USER_ID,
    });
  });

  it("refuses another ceremony's challenge and leaves it in place", async () => {
    const id = await challenge("mfa_authentication");
    await expect(
      claimAuthChallenge({ challengeId: id, type: "authentication" }),
    ).resolves.toBeNull();
    expect(await getPrismaClient().authChallenge.count({ where: { id } })).toBe(
      1,
    );
  });

  it("refuses a challenge begun for another account", async () => {
    const id = await challenge("mfa_registration");
    await expect(
      claimAuthChallenge({
        challengeId: id,
        type: "mfa_registration",
        userId: "someone-else",
      }),
    ).resolves.toBeNull();
  });

  it("refuses an expired challenge", async () => {
    const id = await challenge("authentication", { expiresInMs: -1_000 });
    await expect(
      claimAuthChallenge({ challengeId: id, type: "authentication" }),
    ).resolves.toBeNull();
  });
});
