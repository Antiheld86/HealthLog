import type { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { readMedicationIntakeImportJob } from "@/lib/medications/intake-import-job-status";

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteContext) => {
    const { user } = await requireRecordAuth("manage", "medications");
    const { jobId } = await params;
    annotate({
      action: { name: "medication.intake.history.import.status" },
      meta: { job_id: jobId },
    });

    // No medication argument: this reads the account-wide job, and the helper
    // narrows on `medicationId: null` so a per-medication job id cannot be read
    // through here (or the other way round).
    const job = await readMedicationIntakeImportJob(user.id, jobId);
    if (!job) return apiError("Import job not found", 404);
    return apiSuccess(job);
  },
);
