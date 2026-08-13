import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import {
  createByteCap,
  extractExportXml,
  readCentralDirectory,
} from "../unzip-export-xml";

/**
 * Hand-build a single-entry ZIP archive with the supplied filename +
 * payload. Enough to exercise the central-directory walker + extractor
 * without pulling in a full zip library. `method` selects compression
 * method 8 (deflate, default) or 0 (stored — bytes copied verbatim).
 */
function buildMinimalZip(
  filename: string,
  payload: Buffer,
  method: 0 | 8 = 8,
): Buffer {
  const compressed = method === 8 ? deflateRawSync(payload) : payload;
  const crc32 = (() => {
    // Pre-computed lookup table for CRC-32. node:zlib has crc32 in 22+
    // but we keep the function inline to stay version-agnostic.
    let c: number;
    const table: number[] = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
    let crc = 0 ^ -1;
    for (let i = 0; i < payload.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ payload[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  })();

  const nameBuf = Buffer.from(filename, "utf8");
  // Local file header
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // version
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(method, 8); // method
  localHeader.writeUInt16LE(0, 10); // time
  localHeader.writeUInt16LE(0, 12); // date
  localHeader.writeUInt32LE(crc32, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(payload.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra len

  // Central directory file header
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4); // version made by
  cdh.writeUInt16LE(20, 6); // version needed
  cdh.writeUInt16LE(0, 8); // flags
  cdh.writeUInt16LE(method, 10); // method
  cdh.writeUInt16LE(0, 12); // time
  cdh.writeUInt16LE(0, 14); // date
  cdh.writeUInt32LE(crc32, 16);
  cdh.writeUInt32LE(compressed.length, 20);
  cdh.writeUInt32LE(payload.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt16LE(0, 30); // extra
  cdh.writeUInt16LE(0, 32); // comment
  cdh.writeUInt16LE(0, 34); // disk num
  cdh.writeUInt16LE(0, 36); // internal attrs
  cdh.writeUInt32LE(0, 38); // external attrs
  cdh.writeUInt32LE(0, 42); // local header offset

  // End of Central Directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk-with-cd
  eocd.writeUInt16LE(1, 8); // entries-on-disk
  eocd.writeUInt16LE(1, 10); // total-entries
  eocd.writeUInt32LE(46 + nameBuf.length, 12); // cd size
  // cd offset = local-header + name + data
  eocd.writeUInt32LE(30 + nameBuf.length + compressed.length, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([localHeader, nameBuf, compressed, cdh, nameBuf, eocd]);
}

describe("readCentralDirectory", () => {
  it("walks a single-entry archive", () => {
    const payload = Buffer.from("<HealthData/>");
    const zip = buildMinimalZip("apple_health_export/export.xml", payload);
    const entries = readCentralDirectory(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0].fileName).toBe("apple_health_export/export.xml");
    expect(entries[0].compressionMethod).toBe(8);
    expect(entries[0].uncompressedSize).toBe(payload.length);
  });
});

describe("extractExportXml", () => {
  it("extracts a deflated export.xml member to a temp file", async () => {
    const payload = Buffer.from(
      `<?xml version="1.0"?><HealthData><ExportDate value="2026-05-15"/></HealthData>`,
    );
    const zip = buildMinimalZip("apple_health_export/export.xml", payload);
    const tmp = mkdtempSync(join(tmpdir(), "healthlog-unzip-"));
    const zipPath = join(tmp, "export.zip");
    writeFileSync(zipPath, zip);

    const out = await extractExportXml(zipPath);
    expect(out.xmlBytes).toBe(payload.length);
    expect(out.otherMembers).toHaveLength(0);

    const extracted = readFileSync(out.xmlPath);
    expect(extracted.toString("utf8")).toBe(payload.toString("utf8"));
  });

  // v1.32.1 (issue #588) — the stored (uncompressed) path now runs
  // through the same streaming pipeline as deflate; a stored member
  // must still round-trip byte-exact through it.
  it("extracts a stored (uncompressed) export.xml member to a temp file", async () => {
    const payload = Buffer.from(
      `<?xml version="1.0"?><HealthData><Record type="HKQuantityTypeIdentifierHeartRate"/></HealthData>`,
    );
    const zip = buildMinimalZip("apple_health_export/export.xml", payload, 0);
    const tmp = mkdtempSync(join(tmpdir(), "healthlog-unzip-"));
    const zipPath = join(tmp, "export.zip");
    writeFileSync(zipPath, zip);

    const out = await extractExportXml(zipPath);
    expect(out.xmlBytes).toBe(payload.length);

    const extracted = readFileSync(out.xmlPath);
    expect(extracted.toString("utf8")).toBe(payload.toString("utf8"));
  });

  // (issue #775) — the preflight hook sees the declared sizes before
  // any extraction work starts; throwing there must abort the extract
  // with the hook's error.
  it("aborts before extraction when the preflight hook throws", async () => {
    const payload = Buffer.from(
      `<?xml version="1.0"?><HealthData><ExportDate value="2026-05-15"/></HealthData>`,
    );
    const zip = buildMinimalZip("apple_health_export/export.xml", payload);
    const tmp = mkdtempSync(join(tmpdir(), "healthlog-unzip-"));
    const zipPath = join(tmp, "export.zip");
    writeFileSync(zipPath, zip);

    let seenDeclaredBytes = -1;
    await expect(
      extractExportXml(zipPath, {
        preflight: ({ declaredXmlBytes }) => {
          seenDeclaredBytes = declaredXmlBytes;
          throw new Error("insufficient_memory: preflight refused");
        },
      }),
    ).rejects.toThrow(/insufficient_memory/);
    expect(seenDeclaredBytes).toBe(payload.length);
  });

  it("throws when the export.xml member is missing", async () => {
    const payload = Buffer.from("noop");
    const zip = buildMinimalZip("other-file.txt", payload);
    const tmp = mkdtempSync(join(tmpdir(), "healthlog-unzip-"));
    const zipPath = join(tmp, "export.zip");
    writeFileSync(zipPath, zip);

    await expect(extractExportXml(zipPath)).rejects.toThrow(/missing/);
  });
});

// v1.32.1 (issue #588) — the streaming inflate Transform has no
// `maxOutputLength` option, so the zip-bomb defence moved to a
// hand-rolled byte-counting stage. Exercise it directly at a tiny
// limit; the real 8 GiB ceiling is not practical to trip from a
// fixture.
describe("createByteCap", () => {
  it("passes bytes through unchanged while under the limit", async () => {
    const chunks: Buffer[] = [];
    await pipeline(
      Readable.from([Buffer.from("hello"), Buffer.from("world")]),
      createByteCap(10),
      async function collect(source) {
        for await (const chunk of source) chunks.push(chunk as Buffer);
      },
    );
    expect(Buffer.concat(chunks).toString("utf8")).toBe("helloworld");
  });

  it("rejects the stream once the running total exceeds the limit", async () => {
    await expect(
      pipeline(
        Readable.from([Buffer.from("hello"), Buffer.from("world")]),
        createByteCap(6),
        async function drain(source) {
          for await (const chunk of source) {
            void chunk;
          }
        },
      ),
    ).rejects.toThrow(/exceeds the 6-byte cap/);
  });
});
