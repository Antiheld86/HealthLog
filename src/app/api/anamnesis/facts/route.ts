import { NextRequest } from "next/server";

import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import { isP2002 } from "@/lib/prisma-errors";
import {
  createHealthProfileFact,
  readHealthProfileFacts,
} from "@/lib/profile/health-facts";
import { healthProfileFactWriteSchema } from "@/lib/validations/health-profile-facts";

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "profile");
  const payload = await readHealthProfileFacts(user.id);
  annotate({
    action: { name: "anamnesis.facts.get" },
    meta: {
      current_count: Object.values(payload.current).filter(Boolean).length,
      revision_count: payload.history.length,
    },
  });
  return apiSuccess(payload);
});

async function postFact(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();
  const { data: rawBody, error } = await safeJson(request, {
    maxBytes: 8 * 1024,
  });
  if (error) return error;

  const parsed = healthProfileFactWriteSchema.safeParse(rawBody);
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  try {
    const fact = await createHealthProfileFact(
      user.id,
      parsed.data.kind,
      parsed.data.value,
    );
    await auditLog("anamnesis.fact.create", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { revisionId: fact.id, kind: fact.kind },
    });
    annotate({
      action: {
        name: "anamnesis.fact.create",
        entity_type: "health_profile_fact_revision",
        entity_id: fact.id,
      },
      meta: { kind: fact.kind },
    });
    return apiSuccess(fact, 201);
  } catch (error) {
    if (isP2002(error)) {
      return apiError("A current value already exists for this fact", 409, {
        errorCode: "anamnesis.fact.currentExists",
      });
    }
    throw error;
  }
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postFact));

export const dynamic = "force-dynamic";
