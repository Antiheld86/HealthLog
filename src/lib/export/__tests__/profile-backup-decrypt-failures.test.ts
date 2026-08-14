/**
 * v1.37.19 (A6-9) — the portable export's decryptFailures manifest.
 *
 * Watched red: with the collector dropped from `decryptProfileFieldSoft`
 * (the pre-fix fail-soft that only nulled the field), the first case fails
 * — an export with an unreadable emergency note was byte-identical to one
 * where the note was never written, so the loss was invisible to the
 * person restoring elsewhere.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: (buf: Uint8Array) => {
    const tag = Buffer.from(buf).toString("utf8");
    if (tag === "__bad__") throw new Error("unknown key id");
    return `dec:${tag}`;
  },
  encryptToBytes: (s: string) => new Uint8Array(Buffer.from(s)),
}));

import { buildProfileBackupSection } from "../profile-backup";

function bytes(tag: string): Uint8Array {
  return new Uint8Array(Buffer.from(tag, "utf8"));
}

function makePrisma(profileRow: Record<string, unknown> | null) {
  return {
    userHealthProfile: { findUnique: vi.fn(async () => profileRow) },
    customMetric: { findMany: vi.fn(async () => []) },
    healthProfileFactRevision: { findMany: vi.fn(async () => []) },
    correlationPattern: { findMany: vi.fn(async () => []) },
  } as never;
}

const PROFILE = {
  id: "hp-1",
  aboutMeEncrypted: bytes("about"),
  conditionsEncrypted: null,
  allergiesEncrypted: null,
  coachFocusEncrypted: null,
  pendingQuestionsEncrypted: null,
  aiIncludedSections: undefined,
  emergencyBloodType: null,
  organDonorStatus: null,
  advanceDirectiveStatus: null,
  emergencyContactsEncrypted: null,
  emergencyImplantsEncrypted: null,
  emergencyNoteEncrypted: bytes("__bad__"),
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
};

describe("buildProfileBackupSection — decryptFailures manifest", () => {
  it("discloses an unreadable field in the file instead of a silent null", async () => {
    const section = await buildProfileBackupSection(makePrisma(PROFILE), "u1");

    // The field is still fail-soft null (one unreadable column must not
    // cost the rest of the backup) …
    expect(section.healthProfile?.emergencyNote).toBeNull();
    expect(section.healthProfile?.aboutMe).toBe("dec:about");
    // … but the loss is named in the manifest.
    expect(section.decryptFailures).toEqual(["healthProfile.emergencyNote"]);
  });

  it("reports an empty manifest when everything decrypts", async () => {
    const section = await buildProfileBackupSection(
      makePrisma({ ...PROFILE, emergencyNoteEncrypted: bytes("note") }),
      "u1",
    );
    expect(section.decryptFailures).toEqual([]);
  });

  it("never decrypts on the disaster-recovery path (empty manifest)", async () => {
    const section = await buildProfileBackupSection(makePrisma(PROFILE), "u1", {
      purpose: "disaster-recovery",
    });
    expect(section.decryptFailures).toEqual([]);
    expect(section.healthProfile?.emergencyNote).toBeNull();
  });
});
