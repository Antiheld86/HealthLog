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
import { foldForMatch } from "@/lib/i18n/fold-for-match";

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

/* ──────────────────────────────────────────────────────────────────────────
 * Rhythm classification.
 *
 * The map used to hold three verdicts. Apple's documented set is larger, so a
 * real verdict was being dropped on English devices: "Heart Rate Over 120" and
 * "Heart Rate Under 50" both landed on `null`, which the column cannot tell
 * apart from "this recording carries no classification at all".
 *
 * The English wordings below are OBSERVED, from a corpus of real Apple Watch
 * exports rather than taken from the framework's case names — the CSV writes a
 * display string, and it does not match the `HKElectrocardiogram.Classification`
 * identifiers. `InconclusiveHighHeartRate` reaches the file as "Heart Rate Over
 * 120", not as "High Heart Rate". The threshold is part of the wording and it
 * tracks the watch generation, so the two heart-rate arms match the number
 * rather than pin it.
 *
 * The remaining wordings are Apple's own result names from the ECG
 * instructions-for-use document. They are verdicts the app can produce; a given
 * file may never carry one, but mapping a documented verdict is not the same as
 * leaving a branch in for a hypothetical caller.
 *
 * ## What is still unresolved, and why it is not guessed here
 *
 * The CSV is localised, and not only in this field — a German export writes
 * `Klassifizierung,Sinusrhythmus`, with the KEY translated too. A non-English
 * verdict therefore reaches the `unknown` arm below, and in practice it never
 * gets this far, because the localised metadata keys fail the parse earlier.
 * Translating a clinical verdict is not something to do from memory, so the
 * language half is deliberately left open and named rather than filled in.
 * ────────────────────────────────────────────────────────────────────────── */

/** What the parser was able to make of the `Classification` field. */
export type EcgClassificationOutcome =
  /** A verdict this repository's enum represents. */
  | { kind: "mapped"; value: RhythmClassification }
  /** No classification field, or an empty one — the recording carries no verdict. */
  | { kind: "absent" }
  /** A verdict Apple documents that this repository's enum cannot express. */
  | { kind: "unrepresentable"; verdict: string }
  /** A verdict this parser has never seen — including every non-English one. */
  | { kind: "unknown" };

/**
 * Apple's English verdicts, folded, to the enum member each one means.
 *
 * The inconclusive shapes collapse onto `INCONCLUSIVE` honestly: that member is
 * documented as "device could not classify (poor signal / out-of-range HR)",
 * which is exactly what Apple says each of them is.
 */
const RHYTHM_BY_VERDICT: ReadonlyMap<string, RhythmClassification> = new Map<
  string,
  RhythmClassification
>([
  // Observed in real exports.
  ["sinus rhythm", "NOT_DETECTED"],
  ["inconclusive", "INCONCLUSIVE"],
  // Documented in Apple's ECG instructions for use.
  ["atrial fibrillation", "IRREGULAR"],
  ["atrial fibrillation high heart rate", "IRREGULAR"],
  ["high heart rate no atrial fibrillation detected", "NOT_DETECTED"],
  ["poor recording", "INCONCLUSIVE"],
]);

/**
 * The heart-rate-bound verdicts, whose wording carries the threshold the watch
 * generation decides ("Heart Rate Over 120", "Heart Rate Over 150"). Apple's
 * framework documents both as inconclusive: the classifier could not check for
 * atrial fibrillation at that rate.
 */
const HEART_RATE_BOUND_VERDICT = /^heart rate (?:over|under) \d{2,3}$/;

/**
 * Verdicts Apple documents that this repository's enum has no honest member
 * for. `Unrecognized` is NOT `INCONCLUSIVE`: the device did not fail to
 * classify the waveform, it received a verdict it does not know. Storing it as
 * "could not classify" would assert something Apple did not say.
 */
const UNREPRESENTABLE_VERDICTS: ReadonlySet<string> = new Set(["unrecognized"]);

/**
 * Classify the `Classification` field.
 *
 * Split out from the column write so the parser can tell a verdict it has never
 * heard of from one it knows it cannot represent. Both still end as `null` in
 * the nullable enum column — that is the column's whole vocabulary — but they
 * are different facts, and the previous single `default: return null` could not
 * distinguish them. No column is added for the distinction: nothing reads one
 * yet, and a write-only column is the failure mode this repository keeps
 * rediscovering.
 */
export function classifyEcgRhythm(
  value: string | undefined,
): EcgClassificationOutcome {
  const folded = foldForMatch(value ?? "");
  if (folded === "") return { kind: "absent" };
  const mapped = RHYTHM_BY_VERDICT.get(folded);
  if (mapped) return { kind: "mapped", value: mapped };
  if (HEART_RATE_BOUND_VERDICT.test(folded)) {
    return { kind: "mapped", value: "INCONCLUSIVE" };
  }
  if (UNREPRESENTABLE_VERDICTS.has(folded)) {
    return { kind: "unrepresentable", verdict: folded };
  }
  return { kind: "unknown" };
}

function mapClassification(
  value: string | undefined,
): RhythmClassification | null {
  const outcome = classifyEcgRhythm(value);
  return outcome.kind === "mapped" ? outcome.value : null;
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
        throw parserError("row is malformed");
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
