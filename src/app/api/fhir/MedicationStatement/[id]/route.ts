/**
 * GET /api/fhir/MedicationStatement/{id} — FHIR R4 `read` of one MedicationStatement from the
 * caller's own record.
 *
 * The id space is the export's own (`med-2`), stable for a given record and
 * reporting window. A `read` is a filter over the same emitter the search
 * route pages, so a resource can never differ between the two faces; an id the
 * caller's record does not hold is a `not-found` OperationOutcome.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { medicationStatementsFromReportData } from "@/lib/fhir/resources";
import {
  FHIR_READ_SCOPE,
  loadFhirContext,
  operationOutcome,
  readResponse,
} from "@/lib/fhir/rest";

export const GET = apiHandler(
  async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { user } = await requireAuth(FHIR_READ_SCOPE);
    annotate({ action: { name: "fhir.medicationstatement.read" } });

    // REFUSE, NOT OMIT. The FHIR face serves the SAME whole-record aggregate as
    // `/api/export/health-record`, right down to the decrypted insurance number
    // on the Patient resource, so it gates on the same `doctorReport` module.
    // There is no partial answer that is still a truthful FHIR Bundle, and no
    // background client depends on this draining to stay consistent. The 403
    // `module.disabled` envelope (rather than an OperationOutcome) keeps the
    // errorCode clients already branch on for a disabled module.
    const gate = await requireModuleEnabled(user.id, "doctorReport");
    if (!gate.enabled) return gate.response;

    const rl = await checkRateLimit(`fhir:${user.id}`, 120, 60 * 60 * 1000);
    if (!rl.allowed) {
      return operationOutcome(429, "throttled", "Rate limit exceeded");
    }
    const { id } = await ctx.params;
    const context = await loadFhirContext(user.id);
    annotate({ meta: { resourceId: id } });
    return readResponse(
      medicationStatementsFromReportData(context.data, {
        germanAtc: context.germanAtc,
      }),
      id,
    );
  },
);
