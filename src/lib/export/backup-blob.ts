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
 * timestamps sharing a prefix — so gzip takes that 242 MB to 14 MB, and every
 * copy after it shrinks with it. The same run then completes in about eight
 * seconds with a peak heap of 434 MB. It is also the reason the stored row
 * stops being a liability of its own: the backup lives INSIDE the database it
 * would be needed to restore, so its size is not a cosmetic concern.
 *
 * Both directions. Rows written before this envelope existed are plain
 * `encrypt(json)` and have to keep restoring — an operator whose newest usable
 * copy predates the fix is exactly the person who needs it to work. The marker
 * sits inside the ciphertext rather than in front of it so the stored column
 * keeps the one shape `decrypt()` already understands, key ids and all.
 */
import { Buffer } from "node:buffer";
import { gunzipSync, gzipSync } from "node:zlib";

import { decrypt, encrypt } from "@/lib/crypto";

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
 * A stored `DataBackup.data` string → the backup JSON.
 *
 * Fails closed on every arm: a bad key, a mangled ciphertext or a truncated
 * gzip member throws rather than returning a partial document, because every
 * caller goes on to parse the result as a whole account.
 */
export function unpackBackupBlob(stored: string): string {
  const plaintext = decrypt(stored);
  if (!plaintext.startsWith(GZIP_MARKER)) return plaintext;
  return gunzipSync(
    Buffer.from(plaintext.slice(GZIP_MARKER.length), "base64"),
  ).toString("utf8");
}
