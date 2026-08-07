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

  it("publishes no Guardian refusal a request cannot produce", async () => {
    // `managed_profile.guardian.self` was written, shipped and never
    // reachable: `self_grant` needs the grantor to equal the grantee, and the
    // grantor of a Guardian grant is the PROFILE. Inviting yourself lands on
    // the duplicate refusal; naming the profile is refused a step earlier as
    // `managed_grantee`. Both doors are asserted in
    // `tests/integration/managed-profile-surface.test.ts`, so the arm was
    // known to be dead rather than assumed to be, and it was removed rather
    // than frozen into the published contract.
    const route = await readFile(
      path.join(root, "src/app/api/managed-profiles/[id]/guardians/route.ts"),
      "utf8",
    );
    const spec = await readFile(
      path.join(root, "docs/api/openapi.yaml"),
      "utf8",
    );

    // Non-zero control: the codes that ARE reachable are still named, so this
    // cannot pass by matching an empty file or a renamed family.
    expect(route).toContain("managed_profile.guardian.duplicate");
    expect(route).toContain("managed_profile.guardian.managed_invitee");
    expect(route).not.toContain('errorCode: "managed_profile.guardian.self"');
    expect(spec).not.toContain("managed_profile.guardian.self");
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

  it("does not claim notification fanout before its consent plan exists", async () => {
    const source = await readFile(
      path.join(root, "prisma/schema.prisma"),
      "utf8",
    );

    expect(source).not.toContain("notification dispatcher fans reminders");
    expect(source).toContain("later notification plan");
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
