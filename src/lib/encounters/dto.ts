/**
 * Encounter row → wire DTO.
 *
 * Everything is published resolved. The practitioner comes back as an object
 * and never as a bare id, the links come back with a label and a date, and the
 * appointment's next-due instant comes back computed. A client that had to
 * re-derive any of them would drift from the server the first time one of the
 * derivations changed on one side only.
 *
 * The two free-text columns are `Bytes` ciphertext and decrypt fail-soft: a
 * key-rotation gap on one row reads as a missing reason, not as a 500 on the
 * whole list.
 */
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { getEvent } from "@/lib/logging/context";
import type {
  Encounter,
  EncounterKind,
  EncounterStatus,
  MeasurementReminder,
  Practitioner,
} from "@/generated/prisma/client";
import type { LinkedTarget } from "@/lib/links";
import {
  toPractitionerDTO,
  type PractitionerDTO,
} from "@/lib/practitioners/dto";

/** The three link families a visit can carry, each already resolved. */
export interface EncounterLinksDTO {
  documents: LinkedTarget[];
  labResults: LinkedTarget[];
  conditions: LinkedTarget[];
}

export interface EncounterDTO {
  id: string;
  occurredAt: string;
  status: EncounterStatus;
  kind: EncounterKind;
  /** Resolved, never just an id. `null` when the visit names no practice. */
  practitioner: PractitionerDTO | null;
  reason: string | null;
  outcome: string | null;
  /**
   * The server-computed instant the appointment reminder next fires, when this
   * visit minted one and it has not fired yet. `null` for a visit that already
   * happened, or once the one-shot reminder is spent.
   */
  reminderNextDueAt: string | null;
  /** Present on the detail response; omitted from the list. */
  links?: EncounterLinksDTO;
  createdAt: string;
  updatedAt: string;
}

function decryptField(
  value: Uint8Array | null,
  field: "reason" | "outcome",
): string | null {
  if (!value || value.byteLength === 0) return null;
  try {
    return decryptFromBytes(value);
  } catch (err) {
    getEvent()?.addWarning(
      `encounter ${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

export type EncounterWithRelations = Encounter & {
  practitioner?: Practitioner | null;
  reminder?: Pick<MeasurementReminder, "nextDueAt"> | null;
};

export function toEncounterDTO(
  row: EncounterWithRelations,
  links?: EncounterLinksDTO,
): EncounterDTO {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    status: row.status,
    kind: row.kind,
    practitioner: row.practitioner ? toPractitionerDTO(row.practitioner) : null,
    reason: decryptField(row.reasonEncrypted, "reason"),
    outcome: decryptField(row.outcomeEncrypted, "outcome"),
    reminderNextDueAt: row.reminder?.nextDueAt?.toISOString() ?? null,
    ...(links ? { links } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The list response.
 *
 * Two arrays rather than one sorted list, resolved server-side: "what is
 * coming up" and "what happened" are read in opposite directions, and making
 * the client split and re-sort one array would put that decision in two
 * places.
 */
export interface EncounterListDTO {
  upcoming: EncounterDTO[];
  past: EncounterDTO[];
}
