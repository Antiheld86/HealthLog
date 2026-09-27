/**
 * Practitioner row → wire DTO.
 *
 * Server-authoritative: the client renders these values, it never rebuilds
 * them. The free-text note lives in `noteEncrypted` (Bytes) and is decrypted
 * fail-soft on read, so a key-rotation gap on one row reads as a missing note
 * rather than 500-ing the address book.
 *
 * v1.39.4 — the phone number and the address follow the note into Bytes
 * ciphertext (`phoneEncrypted`, `locationEncrypted`). They read the same way,
 * with one addition: a row the boot-time backfill has not reached yet still
 * holds them in the readable columns, which are read only when there is no
 * ciphertext. A ciphertext that does not open reads as absent, never as the
 * readable column.
 */
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { getEvent } from "@/lib/logging/context";
import type { Practitioner } from "@/generated/prisma/client";

export interface PractitionerDTO {
  id: string;
  name: string;
  specialty: string | null;
  practice: string | null;
  location: string | null;
  phone: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Decrypt a Bytes note fail-soft (null on missing / undecryptable). */
export function decryptPractitionerNote(
  noteEncrypted: Uint8Array | null,
): string | null {
  if (!noteEncrypted || noteEncrypted.byteLength === 0) return null;
  try {
    return decryptFromBytes(noteEncrypted);
  } catch (err) {
    getEvent()?.addWarning(
      `practitioner note decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * A contact field (phone, address): the ciphertext when the row has one, the
 * legacy readable column otherwise. Fail-soft on the ciphertext, like the note.
 */
export function readPractitionerContact(
  ciphertext: Uint8Array | null,
  legacy: string | null,
  field: "phone" | "location",
): string | null {
  if (!ciphertext || ciphertext.byteLength === 0) return legacy;
  try {
    return decryptFromBytes(ciphertext);
  } catch (err) {
    getEvent()?.addWarning(
      `practitioner ${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

export function toPractitionerDTO(row: Practitioner): PractitionerDTO {
  return {
    id: row.id,
    name: row.name,
    specialty: row.specialty,
    practice: row.practice,
    location: readPractitionerContact(
      row.locationEncrypted,
      row.location,
      "location",
    ),
    phone: readPractitionerContact(row.phoneEncrypted, row.phone, "phone"),
    note: decryptPractitionerNote(row.noteEncrypted),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
