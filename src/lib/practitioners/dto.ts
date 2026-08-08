/**
 * Practitioner row → wire DTO.
 *
 * Server-authoritative: the client renders these values, it never rebuilds
 * them. The free-text note lives in `noteEncrypted` (Bytes) and is decrypted
 * fail-soft on read, so a key-rotation gap on one row reads as a missing note
 * rather than 500-ing the address book.
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

export function toPractitionerDTO(row: Practitioner): PractitionerDTO {
  return {
    id: row.id,
    name: row.name,
    specialty: row.specialty,
    practice: row.practice,
    location: row.location,
    phone: row.phone,
    note: decryptPractitionerNote(row.noteEncrypted),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
