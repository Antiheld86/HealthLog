/**
 * The medication half of the doctor report: the per-dose administration
 * ledger and the GLP-1 therapy block.
 *
 * Four leaves cover this domain and each one is a separate release decision:
 * the drug list, the administration ledger, the adherence figures, and the
 * GLP-1 block. A clinician usually wants the list and the adherence rate; the
 * ledger is every logged dose and the GLP-1 block carries a dose history and
 * side-effect tallies, which is a different conversation.
 *
 * Split out of the aggregator with the selection rework.
 */
import { readNote } from "@/lib/crypto/note-cipher";
import type {
  DoctorReportCompliance,
  DoctorReportData,
} from "@/lib/doctor-report-types";
import { resolveMaxMedicationAdministrations } from "@/lib/doctor-report-helpers";
import { matchGlp1SideEffectTags } from "@/lib/medications/glp1-side-effect-tag-match";
import type { Glp1SideEffectTag } from "@/lib/medications/glp1-side-effect-tags";

/** The medication columns the ledger and the GLP-1 block read. */
export interface MedicationRowForReport {
  id: string;
  name: string;
  dose: string | null;
  treatmentClass: string | null;
  doseChanges: Array<{
    effectiveFrom: Date;
    doseValue: number;
    doseUnit: string;
    note: string | null;
    noteEncrypted: Uint8Array | null;
  }>;
  intakeEvents: Array<{ takenAt: Date | null; injectionSite: string | null }>;
}

/** The intake columns the administration ledger reads. */
export interface IntakeEventRowForReport {
  medicationId: string;
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
  injectionSite: string | null;
  medication: {
    id: string;
    name: string;
    dose: string | null;
    atcCode: string | null;
    rxNormCode: string | null;
    deliveryForm: string | null;
  };
}

export interface AdministrationLedger {
  administrations: NonNullable<DoctorReportData["medicationAdministrations"]>;
  truncation: DoctorReportData["medicationAdministrationsTruncation"];
}

/**
 * One entry per ACTED intake — a taken dose (completed) or an explicit skip
 * (not-done). A scheduled-but-unconfirmed slot is not an administration event
 * and is omitted entirely, so the export never asserts an administration that
 * did not happen.
 *
 * The structured dose is resolved from the medication's dose-change history —
 * the latest change effective at or before the administration instant — when
 * one exists. A skip records no dose consumed.
 */
export function buildAdministrationLedger(
  medications: readonly MedicationRowForReport[],
  intakeEvents: readonly IntakeEventRowForReport[],
): AdministrationLedger {
  const doseChangesByMedId = new Map<
    string,
    Array<{ effectiveFrom: Date; doseValue: number; doseUnit: string }>
  >();
  for (const m of medications) {
    doseChangesByMedId.set(
      m.id,
      m.doseChanges.map((dc) => ({
        effectiveFrom: dc.effectiveFrom,
        doseValue: dc.doseValue,
        doseUnit: dc.doseUnit,
      })),
    );
  }

  const resolveDoseInEffect = (
    medicationId: string,
    at: Date,
  ): { value: number; unit: string } | null => {
    const changes = doseChangesByMedId.get(medicationId);
    if (!changes || changes.length === 0) return null;
    // Loaded ordered by `effectiveFrom asc`; take the last one whose
    // `effectiveFrom` is at or before the administration instant.
    let inEffect: { value: number; unit: string } | null = null;
    for (const c of changes) {
      if (c.effectiveFrom.getTime() <= at.getTime()) {
        inEffect = { value: c.doseValue, unit: c.doseUnit };
      } else {
        break;
      }
    }
    return inEffect;
  };

  const all: NonNullable<DoctorReportData["medicationAdministrations"]> = [];
  for (const event of intakeEvents) {
    const isTaken = event.takenAt !== null;
    if (!isTaken && !event.skipped) continue;
    const effectiveAt = isTaken ? (event.takenAt as Date) : event.scheduledFor;
    all.push({
      medicationName: event.medication.name,
      effectiveAt: effectiveAt.toISOString(),
      status: isTaken ? "completed" : "not-done",
      doseText: event.medication.dose || null,
      dose: isTaken
        ? resolveDoseInEffect(event.medication.id, effectiveAt)
        : null,
      injectionSite: event.injectionSite ?? null,
      atcCode: event.medication.atcCode ?? null,
      rxNormCode: event.medication.rxNormCode ?? null,
      deliveryForm: event.medication.deliveryForm ?? null,
    });
  }

  // `intakeEvents` is ordered `scheduledFor: asc`, so the most-recent acted
  // rows are at the tail; keep the last N and flag the trim so the narrative
  // can disclose it. The omitted rows are the OLDEST in the window — recent
  // adherence is preserved intact. The cap is a coarse safety ceiling against
  // a pathological multi-year, many-medication export.
  const cap = resolveMaxMedicationAdministrations(
    process.env.FHIR_MAX_MEDICATION_ADMINISTRATIONS,
  );
  const total = all.length;
  const truncated = total > cap;
  const administrations = truncated ? all.slice(total - cap) : all;
  return {
    administrations,
    truncation: truncated ? { total, included: administrations.length } : null,
  };
}

/**
 * The GLP-1 therapy block: current dose, dose history, last injection, the
 * weight delta over the window, and side-effect tallies.
 *
 * `moodTagRows` is empty unless the MOOD leaf was selected — the aggregator
 * does not read mood entries otherwise — so the side-effect tally collapses to
 * nothing rather than being computed from data the owner withheld.
 */
export function buildGlp1Block(params: {
  medications: readonly MedicationRowForReport[];
  compliance: Record<string, DoctorReportCompliance>;
  weightSeries: ReadonlyArray<{ value: number; measuredAt: string }>;
  moodTagRows: ReadonlyArray<{ tags: string | null }>;
}): DoctorReportData["glp1"] {
  const glp1Meds = params.medications.filter(
    (m) => m.treatmentClass === "GLP1",
  );
  if (glp1Meds.length === 0) return null;

  const weightStartKg = params.weightSeries[0]?.value ?? null;
  const weightEndKg =
    params.weightSeries[params.weightSeries.length - 1]?.value ?? null;
  const weightDeltaKg =
    weightStartKg !== null && weightEndKg !== null
      ? Math.round((weightEndKg - weightStartKg) * 10) / 10
      : null;

  // Tallied by catalogue KEY, in every language the app ships. The tally used
  // to match the stored label against an English/German word list, so a
  // clinician reading a French, Spanish, Italian or Polish patient's report
  // saw "no side effects logged" over a record that had them. A tag outside
  // the catalogue is still never counted — a free-text mood tag must not
  // reach a doctor as an invented symptom.
  const sideEffectCounts = new Map<Glp1SideEffectTag, number>();
  for (const row of params.moodTagRows) {
    for (const tag of matchGlp1SideEffectTags(row.tags).matched) {
      sideEffectCounts.set(tag, (sideEffectCounts.get(tag) ?? 0) + 1);
    }
  }

  return {
    medications: glp1Meds.map((m) => {
      const latest = m.doseChanges[m.doseChanges.length - 1] ?? null;
      const lastIntake = m.intakeEvents[0] ?? null;
      const comp = params.compliance[m.name] ?? {
        taken: 0,
        total: 0,
        skipped: 0,
        missed: 0,
      };
      return {
        name: m.name,
        currentDose: latest
          ? {
              value: latest.doseValue,
              unit: latest.doseUnit,
              since: latest.effectiveFrom.toISOString(),
            }
          : null,
        doseHistory: m.doseChanges.map((dc) => ({
          value: dc.doseValue,
          unit: dc.doseUnit,
          effectiveFrom: dc.effectiveFrom.toISOString(),
          note: readNote(dc.noteEncrypted, dc.note),
        })),
        lastInjection:
          lastIntake && lastIntake.takenAt
            ? {
                date: lastIntake.takenAt.toISOString(),
                site: lastIntake.injectionSite,
              }
            : null,
        compliance: { taken: comp.taken, total: comp.total },
      };
    }),
    weightStartKg,
    weightEndKg,
    weightDeltaKg,
    sideEffects: Array.from(sideEffectCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count })),
  };
}
