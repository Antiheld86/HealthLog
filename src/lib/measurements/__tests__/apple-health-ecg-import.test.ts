import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { strToU8, zipSync } from "fflate";

type ArchiveLimits = {
  maxMembers: number;
  maxEcgMembers: number;
  maxMemberBytes: number;
  maxTotalEcgBytes: number;
  maxCompressionRatio: number;
};

type ArchiveMember = {
  name: string;
  stream: Readable;
};

type NormalizedEcg = {
  recordedAt: Date;
  samplingFrequency: number;
  samples: number[];
  lead: string | null;
  averageHeartRate: number | null;
  rhythmClassification: "IRREGULAR" | "NOT_DETECTED" | "INCONCLUSIVE" | null;
};

type ArchiveSubject = {
  streamAppleHealthEcgMembers(input: {
    archivePath: string;
    limits: ArchiveLimits;
  }): AsyncIterable<ArchiveMember>;
};

type ParserSubject = {
  parseAppleHealthEcgCsv(input: {
    memberName: string;
    stream: Readable;
    maxSamples: number;
  }): Promise<NormalizedEcg>;
};

const tempDirs: string[] = [];

const LIMITS: ArchiveLimits = {
  maxMembers: 8,
  maxEcgMembers: 2,
  maxMemberBytes: 2_048,
  maxTotalEcgBytes: 3_000,
  maxCompressionRatio: 100,
};

function loadArchiveSubject(): Promise<ArchiveSubject> {
  return vi.importActual<ArchiveSubject>("@/lib/apple-health/archive-stream");
}

function loadParserSubject(): Promise<ParserSubject> {
  return vi.importActual<ParserSubject>("@/lib/apple-health/ecg-csv");
}

function archivePath(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "healthlog-ecg-contract-"));
  tempDirs.push(dir);
  const path = join(dir, "export.zip");
  writeFileSync(
    path,
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
      ),
      { level: 6 },
    ),
  );
  return path;
}

function replaceSameLengthName(
  archive: Buffer,
  from: string,
  to: string,
): Buffer {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const out = Buffer.from(archive);
  const needle = Buffer.from(from);
  const replacement = Buffer.from(to);
  let cursor = 0;
  while ((cursor = out.indexOf(needle, cursor)) !== -1) {
    replacement.copy(out, cursor);
    cursor += replacement.length;
  }
  return out;
}

function mutateZipHeaders(
  archive: Buffer,
  memberName: string,
  mutate: (header: Buffer, central: boolean) => void,
): Buffer {
  const out = Buffer.from(archive);
  for (let cursor = 0; cursor <= out.length - 46; cursor += 1) {
    const signature = out.readUInt32LE(cursor);
    const central = signature === 0x02014b50;
    const local = signature === 0x04034b50;
    if (!central && !local) continue;
    const nameLength = out.readUInt16LE(cursor + (central ? 28 : 26));
    const nameStart = cursor + (central ? 46 : 30);
    if (
      out.subarray(nameStart, nameStart + nameLength).toString("utf8") ===
      memberName
    ) {
      mutate(out.subarray(cursor), central);
    }
  }
  return out;
}

function validCsv(overrides: Partial<Record<string, string>> = {}): string {
  const metadata = {
    "Recorded Date": "2026-07-18 08:14:03 +0200",
    Classification: "Sinus Rhythm",
    "Average Heart Rate": "64 bpm",
    "Sample Rate": "512 Hz",
    ...overrides,
  };
  return [
    "Name,Private Patient Name",
    ...Object.entries(metadata).map(([key, value]) => `${key},${value}`),
    "Lead,Voltage",
    "I,0.001",
    "I,-0.002",
    "I,0.003",
  ].join("\n");
}

function singleColumnCsv(
  overrides: Partial<Record<string, string>> = {},
): string {
  const metadata = {
    "Recorded Date": "2026-07-18 08:14:03 +0200",
    Classification: "Sinus Rhythm",
    "Average Heart Rate": "64 bpm",
    "Sample Rate": "512 Hz",
    Lead: "Lead I",
    Unit: "µV",
    ...overrides,
  };
  return [
    "Name,Private Patient Name",
    ...Object.entries(metadata).map(([key, value]) => `${key},${value}`),
    "",
    "1.5",
    "-2.4",
    "3",
  ].join("\n");
}

async function collectMembers(path: string, limits = LIMITS) {
  const subject = await loadArchiveSubject();
  const members: ArchiveMember[] = [];
  for await (const member of subject.streamAppleHealthEcgMembers({
    archivePath: path,
    limits,
  })) {
    members.push(member);
  }
  return members;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("Apple Health ECG archive stream — path and resource bounds", () => {
  it("streams only recognized HKElectrocardiogram CSV members", async () => {
    const path = archivePath({
      "apple_health_export/export.xml": "<HealthData/>",
      "apple_health_export/electrocardiograms/ecg_2026-07-18.csv": validCsv(),
      "apple_health_export/clinical-records/private.json": "{}",
    });

    const members = await collectMembers(path);
    expect(members.map((member) => member.name)).toEqual([
      "apple_health_export/electrocardiograms/ecg_2026-07-18.csv",
    ]);
    expect(members[0].stream).toBeInstanceOf(Readable);
    expect(members[0]).not.toHaveProperty("path");
  });

  it.each([
    "../electrocardiograms/ecg.csv",
    "apple_health_export/electrocardiograms/../../ecg.csv",
    "/apple_health_export/electrocardiograms/ecg.csv",
    "C:\\apple_health_export\\electrocardiograms\\ecg.csv",
  ])("rejects traversal or absolute member name %s", async (name) => {
    await expect(
      collectMembers(
        archivePath({
          "apple_health_export/export.xml": "<HealthData/>",
          [name]: validCsv(),
        }),
      ),
    ).rejects.toThrow(/unsafe|path|member/i);
  });

  it("rejects duplicate normalized ECG member names", async () => {
    const first = "apple_health_export/electrocardiograms/ecg-recording-a.csv";
    const second = "apple_health_export/electrocardiograms/ecg-recording-b.csv";
    const path = archivePath({
      "apple_health_export/export.xml": "<HealthData/>",
      [first]: validCsv(),
      [second]: validCsv(),
    });
    const duplicated = replaceSameLengthName(
      Buffer.from(await import("node:fs").then((fs) => fs.readFileSync(path))),
      second,
      first,
    );
    writeFileSync(path, duplicated);

    await expect(collectMembers(path)).rejects.toThrow(/duplicate/i);
  });

  it.each([
    [
      "encrypted",
      (header: Buffer, central: boolean) =>
        header.writeUInt16LE(1, central ? 8 : 6),
    ],
    [
      "unsupported compression",
      (header: Buffer, central: boolean) =>
        header.writeUInt16LE(99, central ? 10 : 8),
    ],
  ] as const)("rejects %s ECG entries", async (_label, mutate) => {
    const member = "apple_health_export/electrocardiograms/ecg_2026-07-18.csv";
    const path = archivePath({
      "apple_health_export/export.xml": "<HealthData/>",
      [member]: validCsv(),
    });
    const fs = await import("node:fs");
    writeFileSync(
      path,
      mutateZipHeaders(fs.readFileSync(path), member, mutate),
    );

    await expect(collectMembers(path)).rejects.toThrow(
      /encrypted|compression|unsupported/i,
    );
  });

  it("enforces member-count and ECG-count caps before parsing", async () => {
    const files: Record<string, string> = {
      "apple_health_export/export.xml": "<HealthData/>",
    };
    for (let index = 0; index < 4; index += 1) {
      files[
        `apple_health_export/electrocardiograms/ecg_2026-07-${18 + index}.csv`
      ] = validCsv();
    }

    await expect(
      collectMembers(archivePath(files), {
        ...LIMITS,
        maxMembers: 3,
        maxEcgMembers: 2,
      }),
    ).rejects.toThrow(/member|count|limit/i);
  });

  it("rejects declared compression-ratio bombs", async () => {
    const repetitive = `${"0,".repeat(2_000)}\n`;
    await expect(
      collectMembers(
        archivePath({
          "apple_health_export/export.xml": "<HealthData/>",
          "apple_health_export/electrocardiograms/ecg_bomb.csv": repetitive,
        }),
        { ...LIMITS, maxMemberBytes: 10_000, maxCompressionRatio: 2 },
      ),
    ).rejects.toThrow(/compression|ratio|bomb/i);
  });

  it("enforces actual decompressed member bytes even when metadata lies", async () => {
    const member =
      "apple_health_export/electrocardiograms/ecg_actual_bytes.csv";
    const path = archivePath({
      "apple_health_export/export.xml": "<HealthData/>",
      [member]: `${"1,0.001\n".repeat(100)}`,
    });
    const fs = await import("node:fs");
    const lied = mutateZipHeaders(
      fs.readFileSync(path),
      member,
      (header, central) => {
        if (central) header.writeUInt32LE(1, 24);
      },
    );
    writeFileSync(path, lied);

    await expect(
      collectMembers(path, { ...LIMITS, maxMemberBytes: 64 }),
    ).rejects.toThrow(/byte|size|limit/i);
  });

  it("enforces the running total across otherwise valid ECG members", async () => {
    await expect(
      collectMembers(
        archivePath({
          "apple_health_export/export.xml": "<HealthData/>",
          "apple_health_export/electrocardiograms/ecg_a.csv": validCsv(),
          "apple_health_export/electrocardiograms/ecg_b.csv": validCsv(),
        }),
        { ...LIMITS, maxTotalEcgBytes: validCsv().length + 5 },
      ),
    ).rejects.toThrow(/total|byte|limit/i);
  });
});

describe("Apple Health HKElectrocardiogram CSV parser", () => {
  async function parse(csv: string, maxSamples = 8) {
    const subject = await loadParserSubject();
    return subject.parseAppleHealthEcgCsv({
      memberName: "apple_health_export/electrocardiograms/ecg_2026-07-18.csv",
      stream: Readable.from([Buffer.from(csv)]),
      maxSamples,
    });
  }

  it("normalizes a valid recording without returning patient/source labels", async () => {
    const parsed = await parse(validCsv());
    expect(parsed).toMatchObject({
      recordedAt: new Date("2026-07-18T06:14:03.000Z"),
      samplingFrequency: 512,
      samples: [1, -2, 3],
      lead: "I",
      averageHeartRate: 64,
      rhythmClassification: "NOT_DETECTED",
    });
    expect(JSON.stringify(parsed)).not.toMatch(/Private Patient|Apple|WHOOP/i);
  });

  it.each([
    ["Sinus Rhythm", "NOT_DETECTED"],
    ["Atrial Fibrillation", "IRREGULAR"],
    ["Inconclusive", "INCONCLUSIVE"],
    ["Localized or unknown verdict", null],
  ])("passes through device classification %s only", async (raw, expected) => {
    await expect(
      parse(validCsv({ Classification: raw })),
    ).resolves.toMatchObject({ rhythmClassification: expected });
  });

  it.each([
    ["bad timestamp", validCsv({ "Recorded Date": "not-a-date" })],
    ["bad frequency", validCsv({ "Sample Rate": "not-a-rate" })],
    ["non-finite voltage", validCsv().replace("I,-0.002", "I,Infinity")],
    ["missing samples", validCsv().split("Lead,Voltage")[0]],
  ])("rejects malformed %s", async (_label, csv) => {
    await expect(parse(csv)).rejects.toThrow(/invalid|malformed|sample|date/i);
  });

  it("stops reading once the sample cap is exceeded", async () => {
    await expect(parse(validCsv(), 2)).rejects.toThrow(/sample|limit/i);
  });

  it("normalizes Apple's single-column waveform layout", async () => {
    const parsed = await parse(singleColumnCsv());
    expect(parsed).toMatchObject({
      recordedAt: new Date("2026-07-18T06:14:03.000Z"),
      samplingFrequency: 512,
      samples: [2, -2, 3],
      lead: "Lead I",
      averageHeartRate: 64,
      rhythmClassification: "NOT_DETECTED",
    });
    expect(JSON.stringify(parsed)).not.toMatch(/Private Patient/i);
  });

  it("converts millivolt single-column samples to microvolts", async () => {
    await expect(parse(singleColumnCsv({ Unit: "mV" }))).resolves.toMatchObject(
      { samples: [1500, -2400, 3000] },
    );
  });

  it.each([
    ["unsupported unit", singleColumnCsv({ Unit: "V" })],
    ["paired row after the blank separator", `${singleColumnCsv()}\nI,0.001`],
    ["out-of-bounds amplitude", singleColumnCsv().replace("-2.4", "999999")],
    ["non-numeric sample", singleColumnCsv().replace("-2.4", "waveform")],
  ])("rejects a single-column recording with %s", async (_label, csv) => {
    await expect(parse(csv)).rejects.toThrow(
      /invalid|malformed|unsupported|sample/i,
    );
  });

  it("stops single-column reading once the sample cap is exceeded", async () => {
    await expect(parse(singleColumnCsv(), 2)).rejects.toThrow(/sample|limit/i);
  });

  it("never logs or returns plaintext health values on failure", async () => {
    const subject = await loadParserSubject();
    const spies: MockInstance[] = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    const secret = "patient-secret-waveform-0.123456";

    let message = "";
    try {
      await subject.parseAppleHealthEcgCsv({
        memberName: "apple_health_export/electrocardiograms/ecg_2026-07-18.csv",
        stream: Readable.from([Buffer.from(`${validCsv()}\nI,${secret}`)]),
        maxSamples: 8,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(secret);
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });
});
