import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");
  const gate = await requireModuleEnabled(user.id, "insights");
  if (!gate.enabled) return gate.response;
  const patterns = await prisma.correlationPattern.findMany({
    where: { userId: user.id, isCurrent: true },
    orderBy: [{ lastComputedAt: "desc" }, { canonicalKey: "asc" }],
    select: {
      id: true,
      canonicalKey: true,
      family: true,
      factorKey: true,
      outcomeKey: true,
      lagDays: true,
      sampleSize: true,
      effectSize: true,
      pValue: true,
      qValue: true,
      evidenceHash: true,
      lastComputedAt: true,
      dismissedAt: true,
    },
  });

  annotate({
    action: { name: "insights.pattern.list" },
    meta: { total: patterns.length },
  });

  return apiSuccess({
    patterns: patterns.map((pattern) => ({
      ...pattern,
      lastComputedAt: pattern.lastComputedAt.toISOString(),
      dismissedAt: pattern.dismissedAt?.toISOString() ?? null,
    })),
  });
});
