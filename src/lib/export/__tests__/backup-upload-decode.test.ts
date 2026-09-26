/**
 * An uploaded backup is counted after the gunzip as well as before it.
 * Mutation that must turn this red: drop the inflated count (the bomb reads
 * through to the end).
 */
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  BackupUploadDecodeError,
  decodeBackupUpload,
} from "../backup-upload-decode";

async function drain(
  bytes: Buffer,
  limits: Parameters<typeof decodeBackupUpload>[1],
): Promise<Buffer> {
  async function* source() {
    for (let i = 0; i < bytes.length; i += 4096) {
      yield bytes.subarray(i, i + 4096);
    }
  }
  const out: Buffer[] = [];
  for await (const chunk of decodeBackupUpload(source(), limits)) {
    out.push(Buffer.from(chunk));
  }
  return Buffer.concat(out);
}

describe("decodeBackupUpload", () => {
  it("passes plain JSON through and gunzips a gzip file", async () => {
    const json = Buffer.from(JSON.stringify({ userId: "u1", n: [1, 2, 3] }));
    expect(await drain(json, { compressedLimit: 1024 })).toEqual(json);
    expect(await drain(gzipSync(json), { compressedLimit: 1024 })).toEqual(
      json,
    );
  });

  it("refuses a gzip that inflates far past its own size", async () => {
    const bomb = gzipSync(Buffer.alloc(32 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    const refused = drain(bomb, {
      compressedLimit: 1024 * 1024,
      minAllowance: 1024 * 1024,
      ratio: 100,
    });
    await expect(refused).rejects.toBeInstanceOf(BackupUploadDecodeError);
    await expect(refused).rejects.toMatchObject({
      status: 413,
      reason: "inflated_size_exceeded",
    });
  });

  it("refuses a file that is not valid gzip", async () => {
    const broken = Buffer.concat([
      Buffer.from([0x1f, 0x8b]),
      Buffer.from("not gzip"),
    ]);
    await expect(
      drain(broken, { compressedLimit: 1024 }),
    ).rejects.toMatchObject({ status: 422, reason: "invalid_gzip" });
  });

  it("refuses more bytes than the upload limit", async () => {
    await expect(
      drain(Buffer.alloc(10_000, 0x20), { compressedLimit: 5_000 }),
    ).rejects.toMatchObject({ status: 413, reason: "file_size_exceeded" });
  });
});
