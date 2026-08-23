import { randomUUID } from "node:crypto";

import { encrypt, decrypt } from "@/lib/crypto";
import { getEvent } from "@/lib/logging/context";

import { CUSTOM_SYMPTOM_KEY_PREFIX } from "@/lib/cycle/custom-symptoms-shared";

/**
 * v1.15.1 — per-user custom cycle-symptom helpers (the v1.13 custom-mood-tag
 * precedent, mirrored 1:1).
 *
 * Custom symptoms live in the same `cycle_symptoms` table as the seeded
 * catalogue, distinguished by a non-null `userId`. Their key carries a
 * reserved `custom:` prefix so it never collides with a bare catalogue slug,
 * and the write path (`day-log-write.ts:resolveSymptomIds`) already resolves a
 * key against the catalogue rows (userId NULL) PLUS the caller's own rows —
 * so a `custom:` key routes to the user's symptom by construction. The label
 * is held AES-256-GCM-encrypted at rest (`labelEncrypted`): a symptom name is
 * intent-revealing free text, the highest-sensitivity category in the
 * post-Dobbs threat model.
 *
 * This module carries the SERVER-ONLY helpers (uuid mint + label crypto). The
 * client-safe constants + Zod schemas live in `custom-symptoms-shared.ts` and
 * are re-exported here so existing server import sites need no change.
 */

export {
  CUSTOM_SYMPTOM_KEY_PREFIX,
  CUSTOM_SYMPTOM_CATEGORY_ID,
  MAX_CUSTOM_SYMPTOMS_PER_USER,
  isCustomSymptomKey,
  createCustomSymptomSchema,
  updateCustomSymptomSchema,
} from "@/lib/cycle/custom-symptoms-shared";

/** Mint a fresh, collision-proof custom-symptom key. */
export function mintCustomSymptomKey(): string {
  return `${CUSTOM_SYMPTOM_KEY_PREFIX}${randomUUID()}`;
}

/** Encrypt a custom label for storage in `label_encrypted`. */
export function encryptCustomLabel(label: string): string {
  return encrypt(label);
}

/**
 * Decrypt a stored custom label. Returns null on a missing or corrupt
 * ciphertext so one bad row never throws the whole effective-set read.
 */
export function decryptCustomLabel(encoded: string | null): string | null {
  if (!encoded) return null;
  try {
    return decrypt(encoded);
  } catch (err) {
    // A custom label WAS stored but is undecryptable — fail soft (the caller
    // falls back to the generic i18n label) but log it (F-CRYPTO-5) so the loss
    // of a user-renamed symptom is not entirely silent.
    getEvent()?.addWarning(
      `cycle custom-label decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
