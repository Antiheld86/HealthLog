import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { readProfileSummary } from "@/lib/records/profile-summary";

export const dynamic = "force-dynamic";

/**
 * Read-only shared-record profile summary. The underlying fields are bounded
 * and structured so this endpoint never becomes a Settings or AI surface.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "profile");
  const summary = await readProfileSummary(user.id);

  annotate({
    action: { name: "profile.summary.get" },
    meta: {
      allergy_count: summary.allergies.length,
      family_history_count: summary.familyHistory.length,
      fact_count: summary.facts.length,
    },
  });

  return apiSuccess(summary);
});
