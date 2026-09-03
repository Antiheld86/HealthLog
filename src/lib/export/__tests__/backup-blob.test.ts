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
import {
  packBackupBlob,
  packBackupBlobStreaming,
  unpackBackupBlob,
} from "../backup-blob";

/** Pack a whole string through the streaming writer, in small pieces. */
async function packStreamed(json: string, pieceSize = 4_096): Promise<string> {
  return packBackupBlobStreaming(async (write) => {
    for (let at = 0; at < json.length; at += pieceSize) {
      await write(json.slice(at, at + pieceSize));
    }
  });
}

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

  it("reads back a streamed blob byte for byte", async () => {
    const json = sampleJson(2_000);
    expect(unpackBackupBlob(await packStreamed(json))).toBe(json);
  });

  it("is indifferent to where the producer's pieces fall", async () => {
    // Base64 encodes three bytes at a time, so a writer that carries its
    // sub-group remainder across chunks wrongly still round-trips at some
    // piece sizes and corrupts at others. Cover every residue class.
    // Small on purpose: a one-byte piece size means one write per character,
    // and the point of the case is the residue class, not the volume.
    const json = sampleJson(20);
    for (const pieceSize of [1, 2, 3, 7, 64, 1_000, 1_001, json.length]) {
      expect(unpackBackupBlob(await packStreamed(json, pieceSize))).toBe(json);
    }
  });

  it("compresses the streamed form as hard as the buffered one", async () => {
    const json = sampleJson(5_000);
    expect((await packStreamed(json)).length).toBeLessThan(json.length / 4);
  });

  it("keeps the three stored shapes readable side by side", async () => {
    // An operator's newest usable copy may predate either change, and the
    // restore has to work for exactly that person. Plain, compressed and
    // streamed all decode through the one entry point.
    const json = sampleJson(50);
    expect(unpackBackupBlob(encrypt(json))).toBe(json);
    expect(unpackBackupBlob(packBackupBlob(json))).toBe(json);
    expect(unpackBackupBlob(await packStreamed(json))).toBe(json);
  });

  it("cannot be confused for a legacy blob", async () => {
    // The marker starts with a tilde, which is in neither the key-id charset
    // nor the base64 alphabet, so no value the older writers can produce
    // begins with it and the two families never have to be sniffed apart.
    const streamed = await packStreamed(sampleJson(10));
    expect(streamed.startsWith("~")).toBe(true);
    expect(packBackupBlob(sampleJson(10)).startsWith("~")).toBe(false);
    expect(encrypt("x").startsWith("~")).toBe(false);
  });

  it("refuses a streamed blob whose authentication tag was altered", async () => {
    const streamed = await packStreamed(sampleJson(20));
    // The tag is the last 16 bytes of the payload, so the tail of the base64.
    const mangled = `${streamed.slice(0, -6)}${streamed.slice(-6) === "AAAAAA" ? "BBBBBB" : "AAAAAA"}`;
    expect(() => unpackBackupBlob(mangled)).toThrow();
  });

  it("propagates a producer failure instead of storing a truncated blob", async () => {
    await expect(
      packBackupBlobStreaming(async (write) => {
        await write('{"measurements":[');
        throw new Error("row source failed");
      }),
    ).rejects.toThrow("row source failed");
  });
});
