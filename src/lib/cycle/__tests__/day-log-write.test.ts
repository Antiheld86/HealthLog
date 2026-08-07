/**
 * Cycle day-log upsert helper — C-1 encryption write-path data-loss
 * regression coverage.
 *
 * The partial-update upsert loads the existing row before writing. When the
 * stored encrypted note / sensitive envelope cannot be decrypted (rotation
 * gap, GCM corruption), the helper must NOT collapse the column to a re-encrypt
 * of a failed soft-decrypt (which would permanently wipe the user's data when
 * they edit an unrelated field). The stored ciphertext is preserved verbatim
 * unless the user explicitly sets that field.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const client: Record<string, unknown> = {
    cycleDayLog: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    // The write path asks whether the logged day opens a cycle. These cases
    // are about the encryption columns, so the fake answers "no cycles on
    // record" and lets the boundary work run for real against itself — the
    // inference itself is pinned by its own unit + integration cases.
    menstrualCycle: {
      findFirst: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ id: "cyc-1", endDate: null })),
      update: vi.fn(),
    },
    cycleSymptom: { findMany: vi.fn() },
    cycleSymptomLink: { deleteMany: vi.fn(), createMany: vi.fn() },
  };
  client.$transaction = async (fn: (tx: unknown) => unknown) => fn(client);
  return client as {
    cycleDayLog: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    menstrualCycle: {
      findFirst: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    cycleSymptom: { findMany: ReturnType<typeof vi.fn> };
    cycleSymptomLink: {
      deleteMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
    };
  };
});

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/cycle/profile", () => ({
  getOrCreateCycleProfile: vi.fn(async () => ({
    sensitiveCategoryEncryption: true,
  })),
}));

// `decrypt` round-trips an `enc:` prefix and THROWS on any other ciphertext,
// simulating an undecryptable column. The write path must never let that throw
// reach the column write — it preserves the stored ciphertext verbatim.
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (c: string) => {
    if (!c.startsWith("enc:")) throw new Error("undecryptable");
    return c.replace(/^enc:/, "");
  },
}));

import { upsertCycleDayLog } from "@/lib/cycle/day-log-write";
import type { CycleDayLogInput } from "@/lib/validations/cycle";

function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cdl-1",
    date: "2026-06-16",
    flow: null,
    intermenstrualBleeding: false,
    basalBodyTempC: null,
    temperatureExcluded: false,
    ovulationTest: null,
    cervicalMucus: null,
    cervixPosition: null,
    cervixFirmness: null,
    cervixOpening: null,
    sexualActivity: false,
    protectedSex: null,
    pregnancyTest: null,
    progesteroneTest: null,
    contraceptive: null,
    sensitiveEncrypted: null,
    notesEncrypted: null,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.cycleDayLog.upsert.mockResolvedValue({ id: "cdl-1" });
  db.menstrualCycle.findFirst.mockResolvedValue(null);
  db.menstrualCycle.upsert.mockResolvedValue({ id: "cyc-1", endDate: null });
});

describe("upsertCycleDayLog — C-1 undecryptable note preservation", () => {
  it("preserves an undecryptable note verbatim when an unrelated field is edited", async () => {
    db.cycleDayLog.findUnique.mockResolvedValue(
      existingRow({ notesEncrypted: "CORRUPT-NOTE-CIPHERTEXT" }),
    );
    // Edit only `flow`; `note` is omitted.
    const entry = {
      date: "2026-06-16",
      source: "MANUAL",
      flow: "LIGHT",
    } as unknown as CycleDayLogInput;

    await upsertCycleDayLog("u1", entry, "Europe/Berlin");

    const args = db.cycleDayLog.upsert.mock.calls[0][0];
    // The stored ciphertext is carried through unchanged — not nulled, not
    // re-encrypted from a failed soft-decrypt.
    expect(args.update.notesEncrypted).toBe("CORRUPT-NOTE-CIPHERTEXT");
    expect(args.update.flow).toBe("LIGHT");
  });

  it("clears the note on an explicit null even when the stored one is undecryptable", async () => {
    db.cycleDayLog.findUnique.mockResolvedValue(
      existingRow({ notesEncrypted: "CORRUPT-NOTE-CIPHERTEXT" }),
    );
    const entry = {
      date: "2026-06-16",
      source: "MANUAL",
      note: null,
    } as unknown as CycleDayLogInput;

    await upsertCycleDayLog("u1", entry, "Europe/Berlin");

    const args = db.cycleDayLog.upsert.mock.calls[0][0];
    expect(args.update.notesEncrypted).toBeNull();
  });
});

describe("upsertCycleDayLog — C-1 undecryptable sensitive envelope preservation", () => {
  it("preserves an undecryptable sensitive envelope verbatim when an unrelated field is edited", async () => {
    db.cycleDayLog.findUnique.mockResolvedValue(
      existingRow({ sensitiveEncrypted: "CORRUPT-ENVELOPE-CIPHERTEXT" }),
    );
    // Edit only a non-sensitive field; no sensitive field supplied.
    const entry = {
      date: "2026-06-16",
      source: "MANUAL",
      basalBodyTempC: 36.5,
    } as unknown as CycleDayLogInput;

    await upsertCycleDayLog("u1", entry, "Europe/Berlin");

    const args = db.cycleDayLog.upsert.mock.calls[0][0];
    // The envelope ciphertext is preserved, not overwritten with a defaults
    // envelope minted from a failed soft-decrypt.
    expect(args.update.sensitiveEncrypted).toBe("CORRUPT-ENVELOPE-CIPHERTEXT");
    expect(args.update.basalBodyTempC).toBe(36.5);
  });

  it("re-encrypts the envelope when a sensitive field is explicitly supplied", async () => {
    db.cycleDayLog.findUnique.mockResolvedValue(
      existingRow({ sensitiveEncrypted: "CORRUPT-ENVELOPE-CIPHERTEXT" }),
    );
    const entry = {
      date: "2026-06-16",
      source: "MANUAL",
      sexualActivity: true,
    } as unknown as CycleDayLogInput;

    await upsertCycleDayLog("u1", entry, "Europe/Berlin");

    const args = db.cycleDayLog.upsert.mock.calls[0][0];
    // An explicit sensitive write mints a fresh envelope carrying the user's
    // intent — the stored (undecryptable) one is replaced on purpose.
    expect(args.update.sensitiveEncrypted).not.toBe(
      "CORRUPT-ENVELOPE-CIPHERTEXT",
    );
    expect(String(args.update.sensitiveEncrypted)).toContain(
      '"sexualActivity":true',
    );
  });
});
