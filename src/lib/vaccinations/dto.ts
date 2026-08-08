/**
 * Vaccination row → wire DTO.
 *
 * Everything is published resolved. The practitioner comes back as an object
 * and never as a bare id, the visit as a stub with its date and kind, the
 * document links with a label and a date, the catalogue entry as an object or
 * an explicit `null`, and — the one that matters — the SERIES already derived.
 *
 * "Dose 3 of 3" is a property of the whole history, not of the row, and it is
 * computed once on the server (`src/lib/vaccinations/series.ts`) so no client
 * re-derives it. The DTO carries numbers and a boolean, never a localised
 * string: six locales must not ride the API.
 *
 * `catalogEntry: null` is the degrade signal. It means the slug the row
 * carries is not one this release knows — a slug a past version wrote, or one
 * restored from an older backup — and the client falls back to `vaccineName`.
 * It is not an error and it is not empty data.
 */
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { getEvent } from "@/lib/logging/context";
import type {
  Encounter,
  Practitioner,
  VaccinationRecord,
  VaccinationSite,
} from "@/generated/prisma/client";
import {
  toPractitionerDTO,
  type PractitionerDTO,
} from "@/lib/practitioners/dto";
import { resolveCatalogEntry } from "@/lib/vaccinations/vaccine-catalog";
import type { SeriesPosition } from "@/lib/vaccinations/series";

/**
 * One page a dose was transcribed from, as the caller is allowed to see it.
 *
 * `label` and `date` go null together when the caller's grant does not cover
 * the vault. A dose lives in the health background and points into the
 * documents domain, and a grant that opened the background was never consent
 * for what is on the other side of that seam — the FILENAME of a scanned page
 * is itself the sensitive part. `redacted` says which null is a withholding
 * and which is simply a page with no date, so a client never has to guess.
 */
export interface VaccinationDocumentDTO {
  id: string;
  label: string | null;
  date: string | null;
  redacted: boolean;
}

/** What the catalogue knows about the pick, when it still knows it. */
export interface VaccinationCatalogDTO {
  slug: string;
  atc: string;
  category: string;
}

/** The visit this dose was given at, enough to recognise it by. */
export interface VaccinationEncounterDTO {
  id: string;
  occurredAt: string;
  kind: string;
}

export interface VaccinationDTO {
  id: string;
  /** The day, at UTC midnight. An Impfpass carries dates, never times. */
  occurredAt: string;
  /** The stored slug, verbatim — resolvable or not. */
  antigenSlug: string | null;
  /** What the person wrote. May be a trade name; it is their transcription. */
  vaccineName: string | null;
  doseNumber: number | null;
  seriesDoses: number | null;
  lotNumber: string | null;
  site: VaccinationSite | null;
  /**
   * The catalogue's view of `antigenSlug`, or `null` when this release does
   * not know the slug. Null is the signal to render `vaccineName` instead.
   */
  catalogEntry: VaccinationCatalogDTO | null;
  /**
   * Where this dose sits in each of its antigen series, resolved server-side.
   *
   * One entry per component antigen, so a combined dose carries several. Empty
   * for a free-text-only row and for a slug the catalogue cannot resolve — no
   * antigen is guessed from a name string.
   *
   * The client renders text from these numbers: both `position` and `total` →
   * "N of M", only `position` → "dose N", `booster` → "booster". It never
   * recomputes them.
   */
  series: SeriesPosition[];
  /** Resolved, never just an id. `null` when the dose names no practice. */
  practitioner: PractitionerDTO | null;
  /** Resolved stub, never just an id. `null` when no visit is linked. */
  encounter: VaccinationEncounterDTO | null;
  /** The booster reminder this dose satisfied, when one matched. */
  reminderId: string | null;
  note: string | null;
  /** Present on the detail response; omitted from the list. */
  documents?: VaccinationDocumentDTO[];
  createdAt: string;
  updatedAt: string;
}

/** Decrypt the dose note fail-soft: a rotation gap reads as no note, not 500. */
function decryptNote(value: Uint8Array | null): string | null {
  if (!value || value.byteLength === 0) return null;
  try {
    return decryptFromBytes(value);
  } catch (err) {
    getEvent()?.addWarning(
      `vaccination note decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

export type VaccinationWithRelations = VaccinationRecord & {
  practitioner?: Practitioner | null;
  encounter?: Pick<Encounter, "id" | "occurredAt" | "kind"> | null;
};

export function toVaccinationDTO(
  row: VaccinationWithRelations,
  series: SeriesPosition[],
  documents?: VaccinationDocumentDTO[],
): VaccinationDTO {
  const entry = resolveCatalogEntry(row.antigenSlug);
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    antigenSlug: row.antigenSlug,
    vaccineName: row.vaccineName,
    doseNumber: row.doseNumber,
    seriesDoses: row.seriesDoses,
    lotNumber: row.lotNumber,
    site: row.site,
    catalogEntry: entry
      ? { slug: entry.slug, atc: entry.atc, category: entry.category }
      : null,
    series,
    practitioner: row.practitioner ? toPractitionerDTO(row.practitioner) : null,
    encounter: row.encounter
      ? {
          id: row.encounter.id,
          occurredAt: row.encounter.occurredAt.toISOString(),
          kind: row.encounter.kind,
        }
      : null,
    reminderId: row.reminderId,
    note: decryptNote(row.noteEncrypted),
    ...(documents ? { documents } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The list response: one array, newest dose first. */
export interface VaccinationListDTO {
  vaccinations: VaccinationDTO[];
}
