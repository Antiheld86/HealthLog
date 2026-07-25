/**
 * The shape of the owner's saved report profile, without the read that
 * fetches it.
 *
 * The export panel is a client component and needs to parse the blob that
 * rides the `/api/auth/me` payload. Keeping the schema here means it can do
 * that without pulling the Prisma client into the browser bundle — the same
 * separation `saved-profile.ts` documents on the server side.
 */
import { z } from "zod/v4";

import { reportSelectionSchema } from "./selection";

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

/**
 * The render choices the panel starts from when the account has never saved a
 * profile. Presentation only — this is deliberately NOT a scope fallback;
 * there is no such thing here, because a scope nobody chose is the defect.
 */
export const SAVED_PROFILE_FALLBACK = {
  format: "pdf",
  rangeDays: 90,
  includeCharts: true,
} as const;

/** Parse a stored profile blob, or `null` when there is none this build reads. */
export function parseSavedProfile(raw: unknown): SavedReportProfile | null {
  const parsed = savedReportProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
