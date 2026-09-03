/**
 * The envelope a `DataBackup.data` row is stored in: compress, then encrypt.
 *
 * Why it exists. The weekly worker handed `encrypt(JSON.stringify(payload))`
 * straight to Postgres. For an account with a few hundred thousand
 * measurements that is four full copies of the record alive at the same
 * moment: the payload object graph, the JSON string, the base64 ciphertext at
 * 1.33× the JSON, and the copy the database driver makes of that parameter on
 * its way to the wire. Measured on a seeded 445 000-measurement account, the
 * JSON alone is 242 MB and the run dies of heap exhaustion — under a 1 GB heap
 * it never reaches the insert, and on a bigger heap it only reaches it later.
 * The weekly pass was not slow; it could not finish.
 *
 * Compressing first is what makes the whole tail of that pipeline cheap. A
 * health record's JSON is extremely repetitive — the same twenty keys per row,
 * timestamps sharing a prefix — so gzip takes that 242 MB to a few tens of
 * megabytes, and every copy after it shrinks with it. It is also the reason
 * the stored row stops being a liability of its own: the backup lives INSIDE
 * the database it would be needed to restore, so its size is not a cosmetic
 * concern.
 *
 * Compressing first was not enough on its own. Even with a small stored blob,
 * `packBackupBlob` still needs the whole JSON as one argument, and building
 * that string is what exhausts the heap — measured under
 * `--max-old-space-size=450` on the seeded account: `FATAL ERROR: Reached heap
 * limit`. So the writer the weekly job actually uses is
 * `packBackupBlobStreaming`, which never sees a complete copy of the JSON, the
 * gzip output or the ciphertext: rows go in a page at a time, gzip and the
 * cipher consume them as they arrive, and only the base64 answer accumulates,
 * because the destination is a single `text` column and one value is what the
 * column takes.
 *
 * Every direction reads. Three shapes exist in the wild and all three restore:
 * the original `encrypt(json)`, the compressed `encrypt("HLZ1:" + gz)`, and
 * the streamed `~hlgcm1.…` form written from now on. An operator whose newest
 * usable copy predates any of this is exactly the person who needs it to work.
 */
import { Buffer } from "node:buffer";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";

import {
  createStreamEncryptor,
  decrypt,
  decryptStream,
  encrypt,
  isStreamCiphertext,
} from "@/lib/crypto";

/**
 * Prefix of the DECRYPTED plaintext when the body is gzipped-then-base64'd.
 * Chosen so it can never be mistaken for the alternative: a plain payload is
 * always a JSON object and therefore always starts with `{`.
 */
const GZIP_MARKER = "HLZ1:";

/** Serialised backup JSON → the string stored in `DataBackup.data`. */
export function packBackupBlob(json: string): string {
  const compressed = gzipSync(json).toString("base64");
  return encrypt(`${GZIP_MARKER}${compressed}`);
}

/**
 * Produces the backup JSON in pieces. Every piece is written in order.
 *
 * Whatever it resolves to is ignored — the writer's own return value (the row
 * counts) is the caller's business, not the envelope's.
 */
export type BackupJsonProducer = (
  write: (chunk: string) => Promise<void>,
) => Promise<unknown>;

/**
 * Serialised backup JSON, produced in pieces → the stored string.
 *
 * The pipeline is JSON piece → gzip → AES-256-GCM → base64, with nothing
 * buffered end to end but the base64 answer. `producer` decides how big its
 * pieces are; the gzip stream applies backpressure through the promise this
 * hands back, so a fast producer cannot outrun the compressor and pile up
 * chunks in the stream's internal queue.
 *
 * The one copy that cannot be avoided is the answer itself. `data_backups.data`
 * is a single `text` column, so the row has to be one value, and one value has
 * to exist as one string before the driver can bind it.
 */
export async function packBackupBlobStreaming(
  producer: BackupJsonProducer,
): Promise<string> {
  const encryptor = createStreamEncryptor();
  const pieces: string[] = [encryptor.header];
  const gzip = createGzip();

  let failure: unknown = null;
  gzip.on("data", (chunk: Buffer) => {
    try {
      const piece = encryptor.update(chunk);
      if (piece !== "") pieces.push(piece);
    } catch (err) {
      failure ??= err;
      gzip.destroy(err as Error);
    }
  });

  const finished = new Promise<void>((resolve, reject) => {
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });

  const write = async (chunk: string): Promise<void> => {
    if (failure) throw failure;
    if (gzip.write(chunk, "utf8")) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        gzip.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        gzip.off("drain", onDrain);
        reject(err);
      };
      gzip.once("drain", onDrain);
      gzip.once("error", onError);
    });
  };

  try {
    await producer(write);
  } catch (err) {
    gzip.destroy();
    throw err;
  }
  gzip.end();
  await finished;
  if (failure) throw failure;

  pieces.push(encryptor.final());
  return pieces.join("");
}

/**
 * A stored `DataBackup.data` string → the backup JSON.
 *
 * Fails closed on every arm: a bad key, a mangled ciphertext, a tag that does
 * not verify or a truncated gzip member throws rather than returning a partial
 * document, because every caller goes on to parse the result as a whole
 * account.
 */
export function unpackBackupBlob(stored: string): string {
  // Streamed form. Always gzipped — the streaming writer has no other mode —
  // and the tag is verified over the whole ciphertext before a byte of this
  // is unpacked.
  if (isStreamCiphertext(stored)) {
    return gunzipSync(decryptStream(stored)).toString("utf8");
  }
  const plaintext = decrypt(stored);
  if (!plaintext.startsWith(GZIP_MARKER)) return plaintext;
  return gunzipSync(
    Buffer.from(plaintext.slice(GZIP_MARKER.length), "base64"),
  ).toString("utf8");
}
