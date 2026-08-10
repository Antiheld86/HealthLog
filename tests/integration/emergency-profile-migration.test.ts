/**
 * Migration 0331 shape check, against the real migrated Postgres.
 *
 * The testcontainer applies every migration on boot, so this asserts the
 * three enum types and the six nullable columns migration 0331 adds actually
 * exist on the live schema. A migration that never ran, or one that named a
 * column differently from the Prisma model, turns this red before any feature
 * test that depends on the columns runs.
 */
import { describe, expect, it } from "vitest";

import { getPrismaClient } from "./setup";

describe("migration 0331 — emergency profile schema", () => {
  it("adds the six nullable emergency columns to user_health_profiles", async () => {
    const rows = await getPrismaClient().$queryRawUnsafe<
      Array<{ column_name: string; is_nullable: string; data_type: string }>
    >(
      `SELECT column_name, is_nullable, data_type
         FROM information_schema.columns
        WHERE table_name = 'user_health_profiles'
          AND column_name IN (
            'emergency_blood_type',
            'organ_donor_status',
            'advance_directive_status',
            'emergency_contacts_encrypted',
            'emergency_implants_encrypted',
            'emergency_note_encrypted'
          )
        ORDER BY column_name`,
    );

    const byName = new Map(rows.map((r) => [r.column_name, r]));
    for (const col of [
      "emergency_blood_type",
      "organ_donor_status",
      "advance_directive_status",
      "emergency_contacts_encrypted",
      "emergency_implants_encrypted",
      "emergency_note_encrypted",
    ]) {
      expect(byName.get(col), `${col} is missing`).toBeDefined();
      expect(byName.get(col)!.is_nullable, `${col} must be nullable`).toBe(
        "YES",
      );
    }
    expect(byName.get("emergency_contacts_encrypted")!.data_type).toBe("bytea");
    expect(byName.get("emergency_blood_type")!.data_type).toBe("USER-DEFINED");
  });

  it("creates the three emergency enum types with their members", async () => {
    const rows = await getPrismaClient().$queryRawUnsafe<
      Array<{ typname: string; enumlabel: string }>
    >(
      `SELECT t.typname, e.enumlabel
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname IN (
          'emergency_blood_type',
          'organ_donor_status',
          'advance_directive_status'
        )
        ORDER BY t.typname, e.enumsortorder`,
    );

    const byType = new Map<string, string[]>();
    for (const r of rows) {
      (byType.get(r.typname) ?? byType.set(r.typname, []).get(r.typname)!).push(
        r.enumlabel,
      );
    }

    expect(byType.get("emergency_blood_type")).toEqual([
      "A_POS",
      "A_NEG",
      "B_POS",
      "B_NEG",
      "AB_POS",
      "AB_NEG",
      "O_POS",
      "O_NEG",
      "UNKNOWN",
    ]);
    expect(byType.get("organ_donor_status")).toEqual(["YES", "NO", "UNKNOWN"]);
    expect(byType.get("advance_directive_status")).toEqual([
      "EXISTS",
      "NONE",
      "UNKNOWN",
    ]);
  });
});
