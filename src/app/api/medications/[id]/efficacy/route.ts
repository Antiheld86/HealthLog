import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { buildMedicationEfficacy } from "@/lib/medications/efficacy/build-efficacy";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/medications/[id]/efficacy — the resolved, server-authoritative
 * efficacy DTO for one medication: target(s), the target's series with
 * start/dose/pause markers, the before/after-start comparison, the adherence
 * lane, the optional level-shift note, the data-floor state and the retarget
 * options. Cookie- or Bearer-authenticated (the iOS client reads it). The DTO
 * is strictly descriptive — no verdict / score field by construction.
 *
 * The builder's `findFirst({ where: { id, userId } })` is the ownership gate;
 * a missing or foreign id yields the sealed "Medication not found" 404, the
 * same shape `assertMedicationOwnership` mints.
 */
export const GET = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const rl = await checkRateLimit(
      `medication-efficacy:${user.id}`,
      60,
      60_000,
    );
    if (!rl.allowed) {
      return apiError("Too many efficacy requests. Please retry later.", 429);
    }

    const userTz = user.timezone || DEFAULT_TIMEZONE;
    const dto = await buildMedicationEfficacy(user.id, id, userTz);
    if (!dto) {
      return apiError("Medication not found", 404);
    }

    return apiSuccess(dto);
  },
);
