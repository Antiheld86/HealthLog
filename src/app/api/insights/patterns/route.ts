import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
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
