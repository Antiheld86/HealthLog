/**
 * v1.15.1 — per-user custom cycle-symptom catalogue.
 *
 *   GET  /api/cycle/symptoms/custom  — the caller's active custom symptoms,
 *        labels decrypted, so the log-day sheet can merge them into the
 *        seeded chip grid.
 *   POST /api/cycle/symptoms/custom  — create one (`{ label, icon?,
 *        categoryKey? }`). Mints a `custom:<uuid>` key, encrypts the label at
 *        rest, stores the row under the global `custom` category owned by the
 *        caller. Capped per user.
 *
 * Gated (`cycle.disabled` 403) + owner-scoped — a Bearer token for a disabled
 * account never reaches the custom catalogue. The label is intent-revealing
 * free text, so it is NEVER surfaced in a wide-event / audit excerpt (only the
 * icon + key are annotated, mirroring the mood custom-tag precedent).
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import {
  createCustomSymptomSchema,
  decryptCustomLabel,
  encryptCustomLabel,
  mintCustomSymptomKey,
  CUSTOM_SYMPTOM_CATEGORY_ID,
  MAX_CUSTOM_SYMPTOMS_PER_USER,
} from "@/lib/cycle/custom-symptoms";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "cycle");

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  const rows = await prisma.cycleSymptom.findMany({
    where: { userId: user.id, isActive: true },
    orderBy: { sortOrder: "asc" },
    select: { key: true, icon: true, labelEncrypted: true },
  });

  const symptoms = rows.map((r) => ({
    key: r.key,
    label: decryptCustomLabel(r.labelEncrypted),
    icon: r.icon,
    custom: true,
  }));

  annotate({
    action: { name: "cycle.symptom.custom.read" },
    meta: { count: symptoms.length },
  });

  return apiSuccess({ symptoms });
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  // Cap mutation rate so a single session can't flood the encrypted-label
  // catalogue (each create runs an encrypt + audit write).
  const rl = await checkRateLimit(
    `cycle:symptom:custom:${user.id}`,
    30,
    60_000,
  );
  if (!rl.allowed) {
    return apiError("Too many requests, try again later", 429);
  }

  const { data: rawJsonBody, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;
  const parsed = createCustomSymptomSchema.safeParse(rawJsonBody);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "cycle.symptom.custom.invalid",
    });
  }

  const activeCount = await prisma.cycleSymptom.count({
    where: { userId: user.id, isActive: true },
  });
  if (activeCount >= MAX_CUSTOM_SYMPTOMS_PER_USER) {
    return apiError(
      `Custom symptom limit reached (${MAX_CUSTOM_SYMPTOMS_PER_USER})`,
      422,
      { errorCode: "cycle.symptom.custom.limit" },
    );
  }

  const key = mintCustomSymptomKey();
  const created = await prisma.cycleSymptom.create({
    data: {
      categoryId: CUSTOM_SYMPTOM_CATEGORY_ID,
      key,
      // Catalogue rows resolve `labelKey` against the locale; a custom symptom
      // renders its decrypted `label` instead, so labelKey just mirrors the
      // key for a stable, non-empty value.
      labelKey: key,
      labelEncrypted: encryptCustomLabel(parsed.data.label),
      icon: parsed.data.icon ?? null,
      sortOrder: activeCount,
      userId: user.id,
    },
    select: { key: true, icon: true },
  });

  // Audit the create (same tier as a mood-tag custom) — counts + the icon
  // only, NEVER the decrypted label.
  await auditLog("cycle.symptom.custom.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { icon: created.icon },
  });

  annotate({
    action: { name: "cycle.symptom.custom.create" },
    meta: { icon: created.icon },
  });

  return apiSuccess(
    {
      key: created.key,
      label: parsed.data.label,
      icon: created.icon,
      custom: true,
    },
    201,
  );
});
