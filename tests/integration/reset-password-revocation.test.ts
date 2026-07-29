/**
 * SEC-07 / SEC-08 — operator password-reset recovery contract.
 *
 * The production `.mjs` CLI is executed as a real child process against the
 * PostgreSQL Testcontainer. Success must be one credential-family event:
 * password rotation plus revocation of browser, native, API, trusted-device,
 * and elevation credentials. The rollback case installs a test-only trigger
 * that raises during session deletion, proving the whole transaction unwinds
 * without a production schema change or a test-only branch in the CLI.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const { hashPassword, verifyPassword } = await import("@/lib/auth/password");

const TARGET_ID = "reset-cli-target";
const ADMIN_ID = "reset-cli-admin";
const OLD_PASSWORD = "Old target password!123";
const ADMIN_PASSWORD = "Unrelated admin password!456";
const NEW_PASSWORD = "New target password!789";

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function runReset(identifier: string, password: string): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve(process.cwd(), "scripts/reset-password.mjs"),
        identifier,
        password,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

async function seedCredentialFamily(
  userId: string,
  prefix: string,
): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.session.create({
    data: {
      id: `${prefix}-session`,
      userId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  const apiToken = await prisma.apiToken.create({
    data: {
      id: `${prefix}-api`,
      userId,
      name: `${prefix} API`,
      tokenHash: `${prefix}-api-hash`,
      permissions: ["*"],
      revoked: false,
    },
  });
  await prisma.refreshToken.create({
    data: {
      id: `${prefix}-refresh`,
      userId,
      tokenHash: `${prefix}-refresh-hash`,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      revokedAt: null,
    },
  });
  await prisma.trustedDevice.create({
    data: {
      id: `${prefix}-trusted`,
      userId,
      tokenHash: `${prefix}-trusted-hash`,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    },
  });
  await prisma.stepUpElevation.create({
    data: {
      id: `${prefix}-elevation`,
      userId,
      apiTokenId: apiToken.id,
      tokenHash: `${prefix}-elevation-hash`,
      method: "passkey",
      expiresAt: new Date(Date.now() + 5 * 60_000),
    },
  });
}

async function snapshot(userId: string) {
  const prisma = getPrismaClient();
  const [user, sessions, apiTokens, refreshTokens, trustedDevices, elevations] =
    await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { passwordHash: true },
      }),
      prisma.session.findMany({
        where: { userId },
        orderBy: { id: "asc" },
        select: { id: true },
      }),
      prisma.apiToken.findMany({
        where: { userId },
        orderBy: { id: "asc" },
        select: { id: true, revoked: true },
      }),
      prisma.refreshToken.findMany({
        where: { userId },
        orderBy: { id: "asc" },
        select: { id: true, revokedAt: true },
      }),
      prisma.trustedDevice.findMany({
        where: { userId },
        orderBy: { id: "asc" },
        select: { id: true },
      }),
      prisma.stepUpElevation.findMany({
        where: { userId },
        orderBy: { id: "asc" },
        select: { id: true },
      }),
    ]);

  return {
    passwordHash: user.passwordHash,
    sessions,
    apiTokens,
    refreshTokens: refreshTokens.map((row) => ({
      id: row.id,
      revokedAt: row.revokedAt?.toISOString() ?? null,
    })),
    trustedDevices,
    elevations,
  };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  const prisma = getPrismaClient();
  await prisma.user.createMany({
    data: [
      {
        id: TARGET_ID,
        username: "reset-target",
        email: "reset-target@example.test",
        role: "USER",
        passwordHash: await hashPassword(OLD_PASSWORD),
      },
      {
        id: ADMIN_ID,
        username: "reset-admin",
        email: "reset-admin@example.test",
        role: "ADMIN",
        passwordHash: await hashPassword(ADMIN_PASSWORD),
      },
    ],
  });
  await seedCredentialFamily(TARGET_ID, "target");
  await seedCredentialFamily(ADMIN_ID, "admin");
});

describe("scripts/reset-password.mjs (real Postgres)", () => {
  it("changes the target password and revokes every target credential family only", async () => {
    const adminBefore = await snapshot(ADMIN_ID);

    const result = await runReset("reset-target@example.test", NEW_PASSWORD);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('password updated for "reset-target"');
    expect(result.stdout).not.toContain(NEW_PASSWORD);
    expect(result.stderr).not.toContain(NEW_PASSWORD);

    const targetAfter = await snapshot(TARGET_ID);
    expect(targetAfter.passwordHash).toBeTruthy();
    expect(await verifyPassword(targetAfter.passwordHash!, NEW_PASSWORD)).toBe(
      true,
    );
    expect(await verifyPassword(targetAfter.passwordHash!, OLD_PASSWORD)).toBe(
      false,
    );
    expect(targetAfter.sessions).toEqual([]);
    expect(targetAfter.apiTokens).toEqual([
      { id: "target-api", revoked: true },
    ]);
    expect(targetAfter.refreshTokens).toHaveLength(1);
    expect(targetAfter.refreshTokens[0].revokedAt).not.toBeNull();
    expect(targetAfter.trustedDevices).toEqual([]);
    expect(targetAfter.elevations).toEqual([]);

    expect(await snapshot(ADMIN_ID)).toEqual(adminBefore);
    expect(
      await verifyPassword(adminBefore.passwordHash!, ADMIN_PASSWORD),
    ).toBe(true);
  });

  it("leaves all state unchanged for unknown, ambiguous, and weak input", async () => {
    const prisma = getPrismaClient();
    await prisma.user.createMany({
      data: [
        {
          id: "ambiguous-username",
          username: "ambiguous",
          email: "first-ambiguous@example.test",
          passwordHash: await hashPassword(OLD_PASSWORD),
        },
        {
          id: "ambiguous-email",
          username: "second-ambiguous",
          email: "ambiguous",
          passwordHash: await hashPassword(OLD_PASSWORD),
        },
      ],
    });
    const before = await snapshot(TARGET_ID);

    const unknown = await runReset("nobody@example.test", NEW_PASSWORD);
    const ambiguous = await runReset("ambiguous", NEW_PASSWORD);
    const weak = await runReset("reset-target", "too-short");

    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("no user matches");
    expect(ambiguous.code).not.toBe(0);
    expect(ambiguous.stderr).toContain("refusing to guess");
    expect(weak.code).not.toBe(0);
    expect(weak.stderr).toContain("at least 12 characters");
    expect(await snapshot(TARGET_ID)).toEqual(before);
  });

  it("rolls back the password and every credential mutation after a real mid-transaction failure", async () => {
    const prisma = getPrismaClient();
    const before = await snapshot(TARGET_ID);

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_reset_password_fail_session_delete()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.user_id = '${TARGET_ID}' THEN
          RAISE EXCEPTION 'forced reset rollback';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_reset_password_fail_session_delete
      BEFORE DELETE ON sessions
      FOR EACH ROW EXECUTE FUNCTION test_reset_password_fail_session_delete()
    `);

    try {
      const result = await runReset("reset-target", NEW_PASSWORD);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("forced reset rollback");
      expect(await snapshot(TARGET_ID)).toEqual(before);
      expect(await verifyPassword(before.passwordHash!, OLD_PASSWORD)).toBe(
        true,
      );
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS test_reset_password_fail_session_delete
          ON sessions
      `);
      await prisma.$executeRawUnsafe(`
        DROP FUNCTION IF EXISTS test_reset_password_fail_session_delete()
      `);
    }
  });
});
