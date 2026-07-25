/**
 * GET /api/fhir/MedicationAdministration — FHIR R4 `searchset` of the caller's own acted
 * intakes (`completed` taken / `not-done` skip), with the same ATC/RxNorm +
 * dose/route/site coding the document export carries.
 *
 * Read-only. `userId` is narrowed from `requireAuth`; the shared emitters in
 * `@/lib/fhir/resources` are the single source of the coding, so this face and
 * the document export can never describe the same record differently. Offset
 * paging via `_count` (clamped ≤200) / `_offset`.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { medicationAdministrationsFromReportData } from "@/lib/fhir/resources";
import {
  FHIR_READ_SCOPE,
  loadFhirContext,
  operationOutcome,
  parsePaging,
  searchsetResponse,
} from "@/lib/fhir/rest";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth(FHIR_READ_SCOPE);
  annotate({ action: { name: "fhir.medicationadministration.search" } });

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
  const { count, offset } = parsePaging(request.nextUrl.searchParams);
  const context = await loadFhirContext(user.id);

  const all = medicationAdministrationsFromReportData(context.data, {
    germanAtc: context.germanAtc,
  });
  const page = all.slice(offset, offset + count);
  annotate({ meta: { total: all.length, count, offset } });
  return searchsetResponse(request.nextUrl, page, all.length, count, offset);
});
