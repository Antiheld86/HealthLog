/**
 * The owner's saved report selection — "my selection".
 *
 * Persisted on `User.reportSelectionJson` and written after a successful
 * generation, the same way the practice name is. Two kinds of caller read it:
 *
 *   - the export panel and the share-link create form, so the panel opens
 *     already carrying the last scope the owner chose, and
 *   - the surfaces that cannot ask a human — the FHIR REST face and the MCP
 *     doctor-visit resource and prompt.
 *
 * The second group is the reason this exists. Those three call sites used to
 * assemble the full record at server defaults. Now they replay a real act by
 * the owner: the same object reviewed in Settings, no more and no less. An
 * account that has never saved one resolves to the EMPTY selection, so an
 * assistant asking for a record the owner never scoped gets nothing — not a
 * template, not a guess.
 */
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import {
  EMPTY_REPORT_SELECTION,
  reportSelectionSchema,
  selectionFromStoredBlob,
  type ReportSelection,
} from "./selection";

/**
 * The stored profile: the leaf list plus the render choices the panel
 * restores. `format` / `rangeDays` / `includeCharts` are presentation, not
 * scope — no gate reads them — so they ride alongside rather than inside the
 * selection.
 */
export const savedReportProfileSchema = reportSelectionSchema.extend({
  format: z.enum(["pdf", "fhir", "package"]),
  rangeDays: z.number().int().min(1).max(365),
  includeCharts: z.boolean(),
});

export type SavedReportProfile = z.infer<typeof savedReportProfileSchema>;

/** What the panel seeds from when the account has never saved a profile. */
export const SAVED_PROFILE_FALLBACK = {
  format: "pdf",
  rangeDays: 90,
  includeCharts: true,
} as const;

/**
 * Resolve the owner's saved selection.
 *
 * Anything that is not a well-formed v2 blob — null, a drifted shape, a
 * hand-edited row — resolves to the empty selection. A shape the server cannot
 * read is not consent to anything.
 */
export async function resolveSavedSelection(
  userId: string,
): Promise<ReportSelection> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { reportSelectionJson: true },
  });
  if (!row) return EMPTY_REPORT_SELECTION;
  return selectionFromStoredBlob(row.reportSelectionJson);
}

/** Parse a stored profile blob for the panel, or null when there is none. */
export function parseSavedProfile(raw: unknown): SavedReportProfile | null {
  const parsed = savedReportProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
