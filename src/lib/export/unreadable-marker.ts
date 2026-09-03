/**
 * What an export writes where a row could not be decrypted.
 *
 * A portable export carries plaintext, so an encrypted column that this
 * instance can no longer read has to become something. The fail-soft decrypt
 * helpers answer `null`, which in an export file is indistinguishable from a
 * column that was never written — and a restore then writes nothing, so the
 * loss is complete and silent. It is not: the ciphertext was there, and the
 * person is entitled to know a key gap ate it rather than to find a note they
 * remember writing simply gone.
 *
 * The marker is a sentence, not an empty string, for the same reason the Coach
 * transcript's placeholder is: an empty string reads as "there was nothing
 * here", and that is not what happened. It survives a round trip through the
 * restore importer like any other text, so the gap stays visible in the
 * restored account instead of closing over.
 */
export const UNREADABLE_EXPORT_MARKER =
  "[unreadable: encrypted with a key this instance no longer holds]";
