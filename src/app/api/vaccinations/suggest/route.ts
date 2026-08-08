/**
 * `GET /api/vaccinations/suggest?anchor=<iso>` — which dose does a document
 * dated `anchor` most plausibly belong to?
 *
 * The document upload review asks this when a scan is classified `VACCINATION`.
 * The rule — the ±7-day window (shared with the visit moment), and the
 * one-pre-selects / two-offer-a-picker verdict — lives in
 * `src/lib/vaccinations/document-suggestion.ts` and is answered here so the
 * browser never re-derives it.
 *
 * A read of the record's own doses, so it declares the same `profile` domain
 * the immunization list does. `userId` is narrowed from auth; the anchor is the
 * only input and it is a date, not an id.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { vaccinationSuggestQuerySchema } from "@/lib/validations/vaccinations";
import { suggestVaccinationForDate } from "@/lib/vaccinations/document-suggestion";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "profile");

  const params = new URL(request.url).searchParams;
  const parsed = vaccinationSuggestQuerySchema.safeParse({
    anchor: params.get("anchor") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "vaccination.invalid",
    });
  }

  const result = await suggestVaccinationForDate(prisma, {
    userId: user.id,
    anchor: new Date(parsed.data.anchor),
  });

  annotate({
    action: { name: "vaccination.dose.suggest", entity_type: "vaccination" },
    meta: {
      verdict: result.kind,
      candidates:
        result.kind === "many"
          ? result.vaccinations.length
          : result.kind === "one"
            ? 1
            : 0,
    },
  });

  return apiSuccess(result);
});
