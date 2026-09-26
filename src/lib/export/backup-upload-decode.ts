/**
 * An uploaded backup file's bytes, gunzipped when they are gzip, with both
 * ends counted.
 *
 * The upload counted what arrived and nothing after the gunzip, so a few
 * megabytes of gzip could inflate without limit. The JSON scanner keeps every
 * section but the measurements in memory, which turned such a file into an
 * out-of-memory kill of the whole app. The inflated bytes are now held to
 * {@link INFLATION_RATIO} times the compressed bytes read so far (a real
 * backup compresses about tenfold), never less than
 * {@link MIN_INFLATED_ALLOWANCE}, and never more than {@link MAX_INFLATED_BYTES}.
 */
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

/** How far an uploaded gzip may expand, measured on the bytes read so far. */
export const INFLATION_RATIO = 100;
/** Below this much output the ratio is not what protects the process. */
export const MIN_INFLATED_ALLOWANCE = 256 * 1024 * 1024;
/**
 * The largest file an upload may inflate to. A disaster-recovery backup of
 * 1.25 million readings is 662 MB of JSON; this leaves room for several times
 * that record and stops a bomb long before memory does.
 */
export const MAX_INFLATED_BYTES = 4 * 1024 * 1024 * 1024;

/** Thrown for a file that is too large or not valid gzip. */
export class BackupUploadDecodeError extends Error {
  constructor(
    readonly status: 413 | 422,
    message: string,
    readonly reason:
      "file_size_exceeded" | "inflated_size_exceeded" | "invalid_gzip",
    readonly size?: number,
  ) {
    super(message);
    this.name = "BackupUploadDecodeError";
  }
}

export interface DecodeLimits {
  /** Cap on the bytes as they arrive. */
  compressedLimit: number;
  ratio?: number;
  minAllowance?: number;
  maxInflated?: number;
}

/** Bytes → bytes, gunzipped when the file starts with the gzip magic. */
export async function* decodeBackupUpload(
  source: AsyncIterable<Uint8Array>,
  limits: DecodeLimits,
): AsyncGenerator<Uint8Array> {
  const ratio = limits.ratio ?? INFLATION_RATIO;
  const minAllowance = limits.minAllowance ?? MIN_INFLATED_ALLOWANCE;
  const maxInflated = limits.maxInflated ?? MAX_INFLATED_BYTES;
  let seen = 0;
  async function* counted() {
    for await (const chunk of source) {
      seen += chunk.byteLength;
      if (seen > limits.compressedLimit) {
        throw new BackupUploadDecodeError(
          413,
          `Upload exceeds ${Math.round(limits.compressedLimit / 1024 / 1024)} MB limit`,
          "file_size_exceeded",
          seen,
        );
      }
      yield chunk;
    }
  }
  const iterator = counted()[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return;
  const rest = (async function* () {
    yield first.value;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  })();
  const head = first.value;
  if (!(head.byteLength >= 2 && head[0] === 0x1f && head[1] === 0x8b)) {
    yield* rest;
    return;
  }
  const gunzip = Readable.from(rest).pipe(createGunzip());
  let inflated = 0;
  try {
    for await (const chunk of gunzip) {
      inflated += (chunk as Buffer).byteLength;
      const allowed = Math.min(
        maxInflated,
        Math.max(minAllowance, seen * ratio),
      );
      if (inflated > allowed) {
        gunzip.destroy();
        throw new BackupUploadDecodeError(
          413,
          `The uploaded file expands to more than ${Math.round(allowed / 1024 / 1024)} MB, which no backup this server wrote does. Nothing was stored.`,
          "inflated_size_exceeded",
          inflated,
        );
      }
      yield chunk as Buffer;
    }
  } catch (err) {
    if (err instanceof BackupUploadDecodeError) throw err;
    throw new BackupUploadDecodeError(
      422,
      "Uploaded file is not valid gzip",
      "invalid_gzip",
    );
  }
}
