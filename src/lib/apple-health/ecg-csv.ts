/**
 * Incremental parser for Apple Health HKElectrocardiogram CSV exports.
 *
 * Only normalized descriptors and integer microvolt samples leave this
 * module. Patient/source labels are ignored, failures use fixed messages, and
 * the input stream is destroyed as soon as a resource or validation bound is
 * crossed.
 */
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { RhythmClassification } from "@/generated/prisma/client";

export interface NormalizedAppleHealthEcg {
  recordedAt: Date;
  samplingFrequency: number;
  samples: number[];
  lead: string | null;
  averageHeartRate: number | null;
  rhythmClassification: RhythmClassification | null;
}

function parserError(reason: string): Error {
  return new Error(`Invalid Apple Health ECG CSV: ${reason}`);
}

function parseRecordedAt(value: string | undefined): Date {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(
      value?.trim() ?? "",
    );
  if (!match) throw parserError("recorded date is malformed");
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7]}${match[8]}:${match[9]}`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw parserError("recorded date is invalid");
  }
  return parsed;
}

function parseRate(value: string | undefined): number {
  const match = /^(\d+(?:\.\d+)?)\s*Hz$/i.exec(value?.trim() ?? "");
  const rate = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 10_000) {
    throw parserError("sample rate is invalid");
  }
  return Math.round(rate);
}

function parseHeartRate(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const match = /^(\d+(?:\.\d+)?)\s*bpm$/i.exec(value.trim());
  const rate = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 300) {
    throw parserError("average heart rate is invalid");
  }
  return Math.round(rate);
}

function mapClassification(
  value: string | undefined,
): RhythmClassification | null {
  switch (value?.trim().toLowerCase()) {
    case "sinus rhythm":
      return "NOT_DETECTED";
    case "atrial fibrillation":
      return "IRREGULAR";
    case "inconclusive":
      return "INCONCLUSIVE";
    default:
      return null;
  }
}

function resolveUnitScale(value: string | undefined): number | null {
  switch (value?.trim().toLowerCase()) {
    case "µv":
    case "μv":
    case "uv":
    case "microvolt":
    case "microvolts":
      return 1;
    case "mv":
    case "millivolt":
    case "millivolts":
      return 1_000;
    default:
      return null;
  }
}

function splitPair(line: string): [string, string] | null {
  const comma = line.indexOf(",");
  if (comma < 0) return null;
  return [line.slice(0, comma).trim(), line.slice(comma + 1).trim()];
}

export async function parseAppleHealthEcgCsv(input: {
  memberName: string;
  stream: Readable;
  maxSamples: number;
}): Promise<NormalizedAppleHealthEcg> {
  void input.memberName;
  if (!Number.isSafeInteger(input.maxSamples) || input.maxSamples <= 0) {
    throw parserError("sample limit is invalid");
  }

  const metadata = new Map<string, string>();
  const samples: number[] = [];
  let inSamples = false;
  let singleColumn = false;
  let unitScale = 1;
  let lead: string | null = null;
  const lines = createInterface({
    input: input.stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const rawLine of lines) {
      const line = rawLine.replace(/^\uFEFF/, "").trim();
      if (line === "") {
        // Apple's single-column layout declares the lead and unit as
        // metadata rows and separates them from the waveform with a blank
        // line; one bare number per row follows.
        if (!inSamples && metadata.has("Lead") && metadata.has("Unit")) {
          const scale = resolveUnitScale(metadata.get("Unit"));
          if (scale === null) {
            throw parserError("sample unit is unsupported");
          }
          unitScale = scale;
          const declaredLead = metadata.get("Lead") ?? "";
          if (declaredLead.length > 0 && declaredLead.length <= 32) {
            lead = declaredLead;
          }
          inSamples = true;
          singleColumn = true;
        }
        continue;
      }
      if (singleColumn) {
        if (line.includes(",")) {
          throw parserError("row is malformed");
        }
        if (samples.length >= input.maxSamples) {
          throw parserError("sample limit exceeded");
        }
        const value = Number(line);
        if (!Number.isFinite(value)) {
          throw parserError("sample value is invalid");
        }
        const microvolts = Math.round(value * unitScale);
        if (
          !Number.isSafeInteger(microvolts) ||
          Math.abs(microvolts) > 100_000
        ) {
          throw parserError("sample value is invalid");
        }
        samples.push(microvolts);
        continue;
      }
      const pair = splitPair(line);
      if (!pair) {
        // A HEADER row whose value is empty is written without the trailing
        // comma. Every real export opens with a bare `Name` when the name
        // field is blank, which this parser used to reject on line 1 — before
        // it had read anything at all.
        //
        // Only the header section may do this. Inside the single-column
        // waveform a comma-less row is a sample and was handled above; inside
        // the paired waveform every row is `lead,voltage`, so a missing comma
        // there is still malformed.
        //
        // The row contributes NO metadata entry rather than an empty-string
        // one: `Lead` and `Unit` presence is what switches the parser into the
        // single-column mode below, and a valueless key must not be able to
        // trip that switch.
        if (inSamples) {
          throw parserError("row is malformed");
        }
        continue;
      }
      const [key, value] = pair;
      if (!inSamples) {
        if (key.toLowerCase() === "lead" && value.toLowerCase() === "voltage") {
          inSamples = true;
          continue;
        }
        if (key !== "Name") metadata.set(key, value);
        continue;
      }

      if (samples.length >= input.maxSamples) {
        throw parserError("sample limit exceeded");
      }
      const voltage = Number(value);
      if (!Number.isFinite(voltage) || Math.abs(voltage) > 100) {
        throw parserError("sample value is invalid");
      }
      const microvolts = Math.round(voltage * 1_000);
      if (!Number.isSafeInteger(microvolts)) {
        throw parserError("sample value is invalid");
      }
      if (lead === null && key.length > 0 && key.length <= 32) lead = key;
      samples.push(microvolts);
    }

    if (!inSamples || samples.length === 0) {
      throw parserError("samples are missing");
    }
    return {
      recordedAt: parseRecordedAt(metadata.get("Recorded Date")),
      samplingFrequency: parseRate(metadata.get("Sample Rate")),
      samples,
      lead,
      averageHeartRate: parseHeartRate(metadata.get("Average Heart Rate")),
      rhythmClassification: mapClassification(metadata.get("Classification")),
    };
  } catch (error) {
    samples.fill(0);
    input.stream.destroy();
    lines.close();
    if (error instanceof Error && error.message.startsWith("Invalid Apple")) {
      throw error;
    }
    throw parserError("stream could not be parsed");
  }
}
