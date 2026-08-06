import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

let sequence = 0;

async function signInWithFreshMfa() {
  const suffix = sequence++;
  const prisma = getPrismaClient();
  const guardian = await prisma.user.create({
    data: {
      username: `guardian-${suffix}`,
      email: `guardian-${suffix}@example.test`,
      totpConfirmedAt: new Date(),
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: guardian.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return guardian;
}

function createRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/managed-profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(async () => {
  const prisma = getPrismaClient();
  await prisma.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS managed_profile_creation_failure ON "account_grants"',
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION IF EXISTS fail_managed_profile_creation()",
  );
});

describe("managed profile lifecycle (real Postgres)", () => {
  it("creation records a complete DOB and one accepted non-expiring Guardian grant", async () => {
    const guardian = await signInWithFreshMfa();
    const { POST } = await import("@/app/api/managed-profiles/route");

    const response = await POST(
      createRequest({
        displayName: "Managed profile",
        dateOfBirth: "2012-03-04",
        locale: "de",
        timezone: "Europe/Zurich",
      }),
    );
    expect(response.status).toBe(201);

    const body = await response.json();
    const profile = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: body.data.id },
    });
    expect(profile.username).toMatch(/^managed-/);
    expect(profile.username).not.toContain("Managed profile");
    expect(profile.email).toBeNull();
    expect(profile.passwordHash).toBeNull();
    expect(profile.dateOfBirth?.toISOString().slice(0, 10)).toBe("2012-03-04");
    expect(profile.locale).toBe("de");
    expect(profile.timezone).toBe("Europe/Zurich");
    expect(profile.managedProfileAt).not.toBeNull();

    const grant = await getPrismaClient().accountGrant.findFirstOrThrow({
      where: { grantorId: profile.id, granteeId: guardian.id },
    });
    expect(grant.access).toBe("MANAGE");
    expect(grant.acceptedAt).not.toBeNull();
    expect(grant.expiresAt).toBeNull();
  });

  it("creation accepts an absent DOB without fabricating one", async () => {
    await signInWithFreshMfa();
    const { POST } = await import("@/app/api/managed-profiles/route");

    const response = await POST(
      createRequest({
        displayName: "No birth date",
        locale: "en",
        timezone: "UTC",
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    const profile = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: body.data.id },
    });
    expect(profile.dateOfBirth).toBeNull();
  });

  it("creation rolls the profile back when its Guardian grant fails", async () => {
    await signInWithFreshMfa();
    const prisma = getPrismaClient();
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION fail_managed_profile_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'managed profile grant failure'; END; $$",
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER managed_profile_creation_failure BEFORE INSERT ON "account_grants" FOR EACH ROW EXECUTE FUNCTION fail_managed_profile_creation()',
    );

    const { POST } = await import("@/app/api/managed-profiles/route");
    const response = await POST(
      createRequest({
        displayName: "Must roll back",
        locale: "en",
        timezone: "UTC",
      }),
    );
    expect(response.status).toBe(500);
    expect(
      await prisma.user.count({
        where: { managedProfileAt: { not: null } },
      }),
    ).toBe(0);
    expect(await prisma.accountGrant.count()).toBe(0);
  });
});
