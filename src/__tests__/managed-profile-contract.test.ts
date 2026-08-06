import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("managed-profile contract", () => {
  it("requires a cookie-backed fresh MFA proof for creation", async () => {
    const source = await readFile(
      path.join(root, "src/app/api/managed-profiles/route.ts"),
      "utf8",
    );

    expect(source).toContain("requireFreshMfa");
    expect(source).not.toContain("requireFreshMfaIfEnrolled");
  });

  it("requires a cookie-backed fresh MFA proof for profile deletion", async () => {
    const source = await readFile(
      path.join(root, "src/app/api/managed-profiles/[id]/route.ts"),
      "utf8",
    );

    expect(source).toContain("requireFreshMfa");
    expect(source).not.toContain("requireFreshMfaIfEnrolled");
  });

  it("does not publish an emancipation API surface", async () => {
    const source = await readFile(
      path.join(root, "prisma/schema.prisma"),
      "utf8",
    );

    expect(source.toLowerCase()).not.toContain("emancipation");

    const routes = await readdir(
      path.join(root, "src/app/api/managed-profiles"),
      { recursive: true },
    );
    expect(
      routes.some((entry) => entry.toLowerCase().includes("emancip")),
    ).toBe(false);
  });

  it("uses the same record lock for every Guardian-reducing transition", async () => {
    const lifecycle = await readFile(
      path.join(root, "src/lib/managed-profiles/lifecycle.ts"),
      "utf8",
    );
    const grants = await readFile(
      path.join(root, "src/lib/sharing/grants.ts"),
      "utf8",
    );
    const accountDeletion = await readFile(
      path.join(root, "src/app/api/settings/account/route.ts"),
      "utf8",
    );

    expect(lifecycle).toContain("pg_advisory_xact_lock");
    expect(lifecycle).toContain("clearManagedProfileMarker");
    expect(lifecycle).toContain("deleteManagedProfile");
    expect(grants).toContain("reduceManagedProfileGuardian");
    expect(accountDeletion).toContain("deleteGuardianAccountWithLifecycle");
  });
});
