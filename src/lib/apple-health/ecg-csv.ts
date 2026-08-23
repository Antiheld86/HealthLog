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

/**
 * Split a measured quantity into its magnitude and its unit word.
 *
 * The unit is matched loosely on purpose. A real export writes the sampling
 * rate as "511,422 hertz" — the word spelled out, lower case, and separated by
 * a NO-BREAK space in the German files — where the fixtures had always assumed
 * "512 Hz". The magnitude is read through the shared decimal helper, so a
 * comma-region watch's "511,562" is the same rate as "511.422".
 *
 * `\s` covers U+00A0, so the no-break space needs no special case.
 */
function splitQuantity(
  raw: string,
  unit: RegExp,
): { magnitude: number; ok: boolean } {
  const match = /^([+-]?[\d.,]+)\s*([^\s\d]+)$/.exec(raw.trim());
  if (!match) return { magnitude: Number.NaN, ok: false };
  const magnitude = parseDecimal(match[1]);
  if (magnitude === null) return { magnitude: Number.NaN, ok: false };
  return { magnitude, ok: unit.test(match[2]) };
}

/** "Hz", "hz", "hertz", "Hertz" — the same unit, spelled as the region does. */
const HERTZ = /^(?:hz|hertz)$/i;

/** "bpm" and the spelled-out forms a localised export may carry. */
const BEATS_PER_MINUTE = /^(?:bpm|spm)$/i;

function parseRate(value: string | undefined): number {
  const { magnitude, ok } = splitQuantity(value ?? "", HERTZ);
  if (
    !ok ||
    !Number.isFinite(magnitude) ||
    magnitude <= 0 ||
    magnitude > 10_000
  ) {
    throw parserError("sample rate is invalid");
  }
  return Math.round(magnitude);
}

function parseHeartRate(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const { magnitude, ok } = splitQuantity(value, BEATS_PER_MINUTE);
  if (!ok || !Number.isFinite(magnitude) || magnitude <= 0 || magnitude > 300) {
    throw parserError("average heart rate is invalid");
  }
  return Math.round(magnitude);
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

/**
 * Which section of the file the reader is in.
 *
 * The two waveform layouts disagree about what a comma MEANS, so the parser
 * cannot decide that per line — it has to know which side of the boundary it is
 * on. Naming the mode is what makes the two readings safe to hold at once.
 */
type Section =
  /** Key/value metadata rows. A comma separates the key from the value. */
  | "header"
  /** One bare number per row. A comma is a decimal mark. */
  | "single-column"
  /** `lead,voltage` per row. A comma separates the two fields. */
  | "paired";

/**
 * Read one scalar written in either decimal dialect: "-180.596" and "-180,596"
 * are the same measurement, recorded by watches set to different regions.
 *
 * Accepts at most ONE separator. A number carrying thousands grouping
 * ("1.234,5") is refused rather than guessed at, because resolving it needs to
 * know the file's region and nothing in the file states it.
 *
 * The single ambiguous case is a lone separator followed by exactly three
 * digits, where "-180,596" could in principle be grouping rather than a
 * decimal. It is read as a decimal, for two reasons that agree. Observed
 * waveforms carry two- and three-digit fractions in the same file
 * ("-199,83" next to "-217,333"), and grouping is always three, so the
 * two-digit rows settle what the separator is. And a machine writing one bare
 * value per row has no reason to group thousands at all.
 */
function parseDecimal(raw: string): number | null {
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(raw)) return null;
  const value = Number(raw.replace(",", "."));
  return Number.isFinite(value) ? value : null;
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
  let section: Section = "header";
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
        // THE CROSSING into the single-column waveform.
        //
        // Apple's single-column layout declares the lead and unit as metadata
        // rows and separates them from the waveform with a blank line; one
        // bare number per row follows. A blank line on its own does not mean
        // anything — real exports carry two of them mid-header — so the
        // boundary is "a blank line once Lead and Unit have both been
        // declared", and it is taken exactly once, from the header.
        //
        // Everything after this point reads a comma as a decimal mark rather
        // than as a field separator, which is why the parser tracks the
        // section instead of deciding line by line.
        if (
          section === "header" &&
          metadata.has("Lead") &&
          metadata.has("Unit")
        ) {
          const scale = resolveUnitScale(metadata.get("Unit"));
          if (scale === null) {
            throw parserError("sample unit is unsupported");
          }
          unitScale = scale;
          const declaredLead = metadata.get("Lead") ?? "";
          if (declaredLead.length > 0 && declaredLead.length <= 32) {
            lead = declaredLead;
          }
          section = "single-column";
        }
        continue;
      }
      if (section === "single-column") {
        if (samples.length >= input.maxSamples) {
          throw parserError("sample limit exceeded");
        }
        // One value per row, in whichever decimal dialect the watch was set to.
        const value = parseDecimal(line);
        if (value === null) {
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
        if (section !== "header") {
          throw parserError("row is malformed");
        }
        continue;
      }
      const [key, value] = pair;
      if (section === "header") {
        // THE CROSSING into the paired waveform: the `Lead,Voltage` column
        // header. Unlike the single-column boundary this one is explicit in
        // the file, so there is nothing to infer.
        if (key.toLowerCase() === "lead" && value.toLowerCase() === "voltage") {
          section = "paired";
          continue;
        }
        if (key !== "Name") metadata.set(key, value);
        continue;
      }

      if (samples.length >= input.maxSamples) {
        throw parserError("sample limit exceeded");
      }
      // `splitPair` cut on the FIRST comma, so a comma still inside the value
      // is this row's decimal mark, exactly as in the single-column layout.
      const voltage = parseDecimal(value);
      if (voltage === null || Math.abs(voltage) > 100) {
        throw parserError("sample value is invalid");
      }
      const microvolts = Math.round(voltage * 1_000);
      if (!Number.isSafeInteger(microvolts)) {
        throw parserError("sample value is invalid");
      }
      if (lead === null && key.length > 0 && key.length <= 32) lead = key;
      samples.push(microvolts);
    }

    if (section === "header" || samples.length === 0) {
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
