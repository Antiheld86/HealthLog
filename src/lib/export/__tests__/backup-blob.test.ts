/**
 * The stored-backup envelope: compress, then encrypt.
 *
 * The weekly worker used to hand `encrypt(JSON.stringify(payload))` straight to
 * Postgres. For an account with a few hundred thousand measurements that means
 * the object graph, the JSON string, the base64 ciphertext (1.33× the JSON) and
 * the copy the database driver makes of it all alive at once — well over a
 * gigabyte for a record whose JSON is a few hundred megabytes. The run died of
 * memory, not of slow SQL.
 *
 * Compressing before the cipher is what makes the tail of that pipeline cheap:
 * health JSON is extremely repetitive, so everything downstream of the gzip
 * shrinks by an order of magnitude. The envelope has to stay readable both
 * ways — rows written before this change are plain `encrypt(json)` and must
 * keep restoring.
 */
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, expect, it } from "vitest";

import { encrypt } from "@/lib/crypto";
import { packBackupBlob, unpackBackupBlob } from "../backup-blob";

/** A record-shaped string: many rows, few distinct keys. */
function sampleJson(rows: number): string {
  return JSON.stringify({
    schemaVersion: "2",
    measurements: Array.from({ length: rows }, (_, i) => ({
      id: `measurement-${i}`,
      type: "PULSE",
      value: 60 + (i % 30),
      unit: "bpm",
      measuredAt: new Date(Date.UTC(2026, 0, 1, 0, i % 60)).toISOString(),
      source: "APPLE_HEALTH",
      deletedAt: null,
    })),
  });
}

describe("backup blob envelope", () => {
  it("round-trips the exact JSON it was handed", () => {
    const json = sampleJson(200);
    expect(unpackBackupBlob(packBackupBlob(json))).toBe(json);
  });

  it("stores a record-shaped payload far smaller than the plaintext", () => {
    const json = sampleJson(5_000);
    const packed = packBackupBlob(json);
    // The old envelope was 1.33× the JSON. Anything near that means the
    // compression leg is not running.
    expect(packed.length).toBeLessThan(json.length / 4);
  });

  it("still reads a row written before the envelope existed", () => {
    const json = sampleJson(10);
    expect(unpackBackupBlob(encrypt(json))).toBe(json);
  });

  it("fails closed on a corrupt blob rather than returning junk", () => {
    const packed = packBackupBlob(sampleJson(10));
    const mangled = `${packed.slice(0, -8)}AAAAAAAA`;
    expect(() => unpackBackupBlob(mangled)).toThrow();
  });
});
