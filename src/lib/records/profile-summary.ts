import { prisma } from "@/lib/db";
import { readHealthProfileFacts } from "@/lib/profile/health-facts";

export interface ProfileSummaryPayload {
  allergies: Array<{ substance: string; category: string }>;
  familyHistory: Array<{ condition: string; relationship: string }>;
  facts: Array<{ label: string; value: string }>;
}

/**
 * The shared profile surface deliberately carries only the bounded, structured
 * facts a record viewer needs. It does not load settings, AI configuration, or
 * any encrypted free-text field.
 */
export async function readProfileSummary(
  userId: string,
): Promise<ProfileSummaryPayload> {
  const [allergies, familyHistory, healthFacts] = await Promise.all([
    prisma.allergy.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { substance: true, category: true },
    }),
    prisma.familyHistoryEntry.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { condition: true, relationship: true },
    }),
    readHealthProfileFacts(userId),
  ]);

  return {
    allergies,
    familyHistory,
    facts: Object.values(healthFacts.current).flatMap((fact) =>
      fact?.value && !fact.unreadable
        ? [{ label: fact.kind, value: fact.value }]
        : [],
    ),
  };
}
