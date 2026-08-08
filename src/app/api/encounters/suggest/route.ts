/**
 * `GET /api/encounters/suggest?anchor=<iso>` — which visit does a record dated
 * `anchor` most plausibly belong to?
 *
 * The three capture moments that ask this question live in the browser: the
 * document upload review, the lab extraction review and the manual lab form.
 * The rule they ask about — the ±7-day window, the DONE / PLANNED filter, and
 * the one-pre-selects / two-offer-a-picker verdict — lives in
 * `src/lib/encounters/suggest-window.ts` and is answered here so all three read
 * the same answer. Handing the client a windowed list and letting it decide
 * would put the rule in two places, and the copy in the browser is the one
 * nobody re-reads when the rule changes.
 *
 * A read of the record's own visits, so it declares the same domain the visit
 * list does. `userId` is narrowed from auth; the anchor is the only input and
 * it is a date, not an id.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { encounterSuggestQuerySchema } from "@/lib/validations/encounters";
import { suggestEncounterForDate } from "@/lib/encounters/suggest-window";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "profile");

  const params = new URL(request.url).searchParams;
  const parsed = encounterSuggestQuerySchema.safeParse({
    anchor: params.get("anchor") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "encounter.invalid",
    });
  }

  const result = await suggestEncounterForDate(prisma, {
    userId: user.id,
    anchor: new Date(parsed.data.anchor),
  });

  annotate({
    action: { name: "encounter.visit.suggest", entity_type: "encounter" },
    meta: {
      verdict: result.kind,
      candidates:
        result.kind === "many"
          ? result.encounters.length
          : result.kind === "one"
            ? 1
            : 0,
    },
  });

  return apiSuccess(result);
});
