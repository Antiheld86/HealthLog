import type { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { readMedicationIntakeImportJob } from "@/lib/medications/intake-import-job-status";

interface RouteContext {
  params: Promise<{ id: string; jobId: string }>;
}

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteContext) => {
    const { user } = await requireRecordAuth("manage", "medications");
    const { id: medicationId, jobId } = await params;
    annotate({
      action: { name: "medication.intake.import.status" },
      meta: { job_id: jobId, medication_id: medicationId },
    });

    const job = await readMedicationIntakeImportJob(
      user.id,
      jobId,
      medicationId,
    );
    if (!job) return apiError("Import job not found", 404);
    return apiSuccess(job);
  },
);
