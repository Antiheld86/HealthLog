import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveGuardianRecordSettingsAccess } from "@/lib/record-settings/access";

const fromRoot = (...segments: string[]) => resolve(process.cwd(), ...segments);

describe("record settings authorization", () => {
  it("keeps actor and record separation", async () => {
    const [authMeRoute, recordSettingsRoute] = await Promise.all([
      readFile(fromRoot("src/app/api/auth/me/route.ts"), "utf8"),
      readFile(fromRoot("src/app/api/record-settings/route.ts"), "utf8"),
    ]);

    const access = resolveGuardianRecordSettingsAccess({
      actor: { id: "guardian-1" },
      grantId: "grant-1",
      user: { id: "managed-record-1", managedProfileAt: new Date() },
    });

    expect(access).toMatchObject({
      actorId: "guardian-1",
      recordId: "managed-record-1",
      recordKind: "managed",
      relationship: "guardian",
    });
    expect(authMeRoute).toContain("requireAuth");
    expect(authMeRoute).not.toContain("requireGuardianAuth");
    expect(authMeRoute).not.toContain("requireRecordAuth");
    expect(recordSettingsRoute).toContain("requireGuardianAuth");
    expect(recordSettingsRoute).toContain("toRecordSettingsDto");
  });
});
