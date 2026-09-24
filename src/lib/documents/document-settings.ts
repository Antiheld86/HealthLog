/**
 * Per-user document-vault AI settings.
 *
 * `documentAutoReadEnabled(userId)` reads the `documentsAutoAiRead` opt-in — the
 * single switch that authorises ambient (no-per-document-tap) AI reading of
 * uploaded documents. OFF by default: the vault stays local-first and every
 * external egress needs an explicit per-document action + consent receipt.
 *
 * It is a trigger, not a consent. Switching it on mints an `ai_extraction`
 * receipt, and that receipt is what the document egress re-check reads, so a
 * revoked receipt stops external reading even with the flag still on. Readers:
 *   - the summary job and its catch-up pass run only while it is ON;
 *   - the auto-index-on-upload job stays strictly local when it is OFF and uses
 *     the document-order external pick when it is ON.
 */
import { prisma } from "@/lib/db";

/**
 * True when the user has opted into automatic AI reading of uploaded documents.
 * A missing row (deleted account raced against a job) resolves to `false` —
 * fail-closed to the local-first posture, never to external egress.
 */
export async function documentAutoReadEnabled(
  userId: string,
): Promise<boolean> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { documentsAutoAiRead: true },
  });
  return row?.documentsAutoAiRead ?? false;
}
