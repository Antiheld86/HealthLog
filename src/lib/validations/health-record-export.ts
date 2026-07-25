/**
 * The health-record / doctor-handover export selection.
 *
 * One strict Zod schema driving `POST /api/export/health-record`. `.strict()`
 * rejects unknown keys, and there is intentionally NO `userId` field — the
 * user is always narrowed from `requireAuth()`, never accepted from the body.
 *
 * `selection` is REQUIRED and is the leaf inclusion list. The grouped
 * `sections` shape it replaces resolved an absent key to "included", so a
 * caller who sent nothing received roughly fifty metrics plus the medication
 * list, labs, allergies and family history — a scope nobody chose. Sending
 * `sections` now 422s with the key named rather than being folded into a
 * default, because silently accepting the old shape would mean silently
 * choosing a scope the caller did not express.
 *
 * The AI summary is gone with it. Its text was pulled from the cached
 * briefing with no relation to the selection at all, so its scope could not be
 * proven — and prose whose scope cannot be proven cannot ride a document whose
 * whole point is a proven scope.
 */
import { z } from "zod/v4";

import { locales } from "@/lib/i18n/config";
import { reportSelectionSchema } from "@/lib/report-selection/selection";

export const exportSelectionSchema = z
  .object({
    format: z.enum(["pdf", "fhir", "package"]),
    range: z
      .object({
        startDate: z.iso.datetime({ offset: true }).optional(),
        endDate: z.iso.datetime({ offset: true }).optional(),
        days: z.number().int().min(1).max(365).optional(),
      })
      .strict()
      .optional(),
    /** The leaf inclusion list. Required: a scope has to be stated. */
    selection: reportSelectionSchema,
    locale: z.enum(locales).optional(),
    practiceName: z.string().max(120).optional(),
    includeCharts: z.boolean().optional(),
    // FHIR only: additionally emit the German BfArM ATC URI alongside the WHO
    // entry on each medication concept (WHO stays first, byte-identical). When
    // omitted, the route derives it from a German-region locale.
    germanAtc: z.boolean().optional(),
  })
  .strict();

export type ExportSelection = z.infer<typeof exportSelectionSchema>;
