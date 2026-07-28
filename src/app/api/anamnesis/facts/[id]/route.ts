import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  correctHealthProfileFact,
  removeHealthProfileFact,
} from "@/lib/profile/health-facts";
import {
  healthProfileFactCorrectionSchema,
  validateCorrectedFactValue,
  type HealthProfileFactKind,
} from "@/lib/validations/health-profile-facts";

type RouteParams = { params: Promise<{ id: string }> };

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;
    const { data: rawBody, error } = await safeJson(request, {
      maxBytes: 8 * 1024,
    });
    if (error) return error;

    const parsed = healthProfileFactCorrectionSchema.safeParse(rawBody);
    if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

    const current = await prisma.healthProfileFactRevision.findFirst({
      where: {
        id,
        userId: user.id,
        validUntil: null,
        supersededByRevisionId: null,
      },
      select: { kind: true },
    });
    if (!current) return apiError("Current profile fact not found", 404);

    const value = validateCorrectedFactValue(
      current.kind as HealthProfileFactKind,
      parsed.data.value,
    );
    if (!value) {
      return apiError("Value is not valid for this fact kind", 422, {
        errorCode: "anamnesis.fact.invalidValue",
      });
    }

    const corrected = await correctHealthProfileFact(user.id, id, value);
    if (!corrected) {
      return apiError("Profile fact changed since it was loaded", 409, {
        errorCode: "anamnesis.fact.conflict",
      });
    }

    await auditLog("anamnesis.fact.correct", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        priorRevisionId: id,
        revisionId: corrected.id,
        kind: corrected.kind,
      },
    });
    annotate({
      action: {
        name: "anamnesis.fact.correct",
        entity_type: "health_profile_fact_revision",
        entity_id: corrected.id,
      },
      meta: { kind: corrected.kind },
    });
    return apiSuccess(corrected);
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const current = await prisma.healthProfileFactRevision.findFirst({
      where: {
        id,
        userId: user.id,
        validUntil: null,
        supersededByRevisionId: null,
      },
      select: { kind: true },
    });
    if (!current) return apiError("Current profile fact not found", 404);

    const removed = await removeHealthProfileFact(user.id, id);
    if (!removed) {
      return apiError("Profile fact changed since it was loaded", 409, {
        errorCode: "anamnesis.fact.conflict",
      });
    }

    await auditLog("anamnesis.fact.remove", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        revisionId: removed.id,
        kind: removed.kind,
      },
    });
    annotate({
      action: {
        name: "anamnesis.fact.remove",
        entity_type: "health_profile_fact_revision",
        entity_id: removed.id,
      },
      meta: { kind: removed.kind },
    });
    return apiSuccess(removed);
  },
);

export const dynamic = "force-dynamic";
