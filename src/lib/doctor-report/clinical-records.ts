/**
 * The structured clinical records on the doctor report: labs, illness
 * episodes, allergies and family history.
 *
 * Each one is its own leaf and its own read. A refused leaf is not queried at
 * all — the payload reflects "this was never fetched", not "this was fetched
 * and then dropped". No free-text note column is ever selected on this path;
 * the only decrypted free text is the allergy reaction, which is what an
 * allergy record is for.
 *
 * Split out of the aggregator with the selection rework.
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { decryptAllergyReaction } from "@/lib/doctor-report-helpers";
import type { DoctorReportData } from "@/lib/doctor-report-types";

/**
 * Structured lab results over the window, reduced to the latest reading per
 * analyte with a count, so the report is a concise panel rather than a raw
 * dump. Analyte keys fold case-insensitively.
 */
export async function loadLabResults(
  userId: string,
  start: Date,
  end: Date,
): Promise<DoctorReportData["labResults"]> {
  const rows = await prisma.labResult.findMany({
    where: { userId, takenAt: { gte: start, lte: end }, deletedAt: null },
    orderBy: { takenAt: "asc" },
    select: {
      panel: true,
      analyte: true,
      value: true,
      valueText: true,
      unit: true,
      referenceLow: true,
      referenceHigh: true,
      takenAt: true,
    },
  });
  const byAnalyte = new Map<
    string,
    NonNullable<DoctorReportData["labResults"]>[number]
  >();
  for (const r of rows) {
    const key = r.analyte.toLowerCase();
    const prev = byAnalyte.get(key);
    byAnalyte.set(key, {
      panel: r.panel,
      analyte: r.analyte,
      value: r.value,
      valueText: r.valueText,
      unit: r.unit,
      referenceLow: r.referenceLow,
      referenceHigh: r.referenceHigh,
      takenAt: r.takenAt.toISOString(),
      count: (prev?.count ?? 0) + 1,
    });
  }
  const collapsed = Array.from(byAnalyte.values());
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * Illness / condition episodes overlapping the window. An episode overlaps
 * when it began on or before the window end AND is either still ongoing or
 * resolved on or after the window start. Labels, lifecycle and dates only.
 */
export async function loadIllnessEpisodes(
  userId: string,
  start: Date,
  end: Date,
): Promise<DoctorReportData["illnessEpisodes"]> {
  const rows = await prisma.illnessEpisode.findMany({
    where: {
      userId,
      deletedAt: null,
      onsetAt: { lte: end },
      OR: [{ resolvedAt: null }, { resolvedAt: { gte: start } }],
    },
    orderBy: { onsetAt: "asc" },
    select: {
      label: true,
      type: true,
      lifecycle: true,
      onsetAt: true,
      resolvedAt: true,
    },
  });
  const mapped = rows.map((e) => ({
    label: e.label,
    type: e.type,
    lifecycle: e.lifecycle,
    onsetAt: e.onsetAt.toISOString(),
    resolvedAt: e.resolvedAt ? e.resolvedAt.toISOString() : null,
  }));
  return mapped.length > 0 ? mapped : null;
}

/**
 * Structured allergy records. Reference data, not time-windowed — a
 * penicillin allergy does not expire with the report window.
 *
 * The reaction description decrypts fail-soft per row. A reaction that WAS
 * recorded but cannot be read is flagged rather than silently blanked, so the
 * renderer prints an honest marker instead of a clinician-facing export
 * reading as "no reaction recorded".
 */
export async function loadAllergies(
  userId: string,
): Promise<DoctorReportData["allergies"]> {
  const rows = await prisma.allergy.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      substance: true,
      category: true,
      type: true,
      severity: true,
      status: true,
      reactionEncrypted: true,
    },
  });
  const mapped = rows.map((r) => {
    const { reaction, reactionUnreadable } = decryptAllergyReaction(
      r.reactionEncrypted,
    );
    if (reactionUnreadable) {
      getEvent()?.addWarning(
        `doctor-report: allergy reaction decrypt failed for ${userId} (substance=${r.substance})`,
      );
    }
    return {
      substance: r.substance,
      category: r.category,
      type: r.type,
      severity: r.severity,
      status: r.status,
      reaction,
      reactionUnreadable,
    };
  });
  return mapped.length > 0 ? mapped : null;
}

/** Structured family history. Same stance as allergies: reference data. */
export async function loadFamilyHistory(
  userId: string,
): Promise<DoctorReportData["familyHistory"]> {
  const rows = await prisma.familyHistoryEntry.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { relationship: true, condition: true, ageAtOnset: true },
  });
  return rows.length > 0 ? rows : null;
}
