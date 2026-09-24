/**
 * Consent withdrawal deletes the regenerable model-written text, against real
 * Postgres, and keeps the person's own records.
 *
 * What is pinned here and nowhere else:
 *
 *   - the purge reaches every surface the analysis consent covered: status
 *     notes, the cached briefing, model-written narratives (the deterministic
 *     one stays), reaction lines (the marker stays), workout paragraphs;
 *   - Coach conversations and facts, and a document's stored summary, stay;
 *   - revoke and purge are one transaction: a purge that fails leaves the
 *     receipt active and every row in place;
 *   - a withdrawal that leaves the analysis covered, or that never touched
 *     it, deletes nothing.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  purgeRegenerableAiText,
  withdrawConsent,
} from "@/lib/consent/withdrawal";

const BYTES = Buffer.from("ciphertext-stand-in", "utf8");

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function seed(username: string, kinds: string[]) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      insightsCachedText: JSON.stringify({ briefing: "model prose" }),
      insightsCachedAt: new Date(),
      insightsSnapshotHash: "hash",
    },
  });
  for (const kind of kinds) {
    await prisma.consentReceipt.create({
      data: { userId: user.id, kind, artefact: "{}", signedAt: new Date() },
    });
  }
  await prisma.insightStatusCache.createMany({
    data: [
      {
        userId: user.id,
        metric: "weight",
        locale: "en",
        dateKey: "2026-09-20",
        textEncrypted: BYTES,
      },
      {
        userId: user.id,
        metric: "metric:RESTING_HEART_RATE",
        locale: "en",
        dateKey: "2026-09-20",
        textEncrypted: BYTES,
      },
    ],
  });
  await prisma.insightNarrative.createMany({
    data: [
      {
        userId: user.id,
        period: "week",
        locale: "en",
        dateKey: "2026-09-20",
        encryptedContent: BYTES,
        providerType: "anthropic",
      },
      {
        userId: user.id,
        period: "month",
        locale: "en",
        dateKey: "2026-09-20",
        encryptedContent: BYTES,
        providerType: "deterministic",
      },
    ],
  });
  await prisma.arrivalReaction.create({
    data: {
      userId: user.id,
      kind: "weight",
      localDate: "2026-09-20",
      occurredAt: new Date(),
      lineEncrypted: BYTES,
      generatedAt: new Date(),
    },
  });
  const workout = await prisma.workout.create({
    data: {
      userId: user.id,
      sportType: "cycling",
      startedAt: new Date("2026-09-20T06:00:00Z"),
      endedAt: new Date("2026-09-20T06:45:00Z"),
      durationSec: 2700,
      source: "APPLE_HEALTH",
      externalId: `ext-${username}`,
    },
  });
  await prisma.workoutInsight.create({
    data: {
      userId: user.id,
      workoutId: workout.id,
      paragraphEncrypted: BYTES,
      inputHash: "h",
      promptVersion: "1",
      providerType: "anthropic",
      locale: "en",
      generatedAt: new Date(),
    },
  });
  const conversation = await prisma.coachConversation.create({
    data: { userId: user.id, title: "t", summaryEncrypted: BYTES },
  });
  await prisma.coachFact.create({
    data: {
      userId: user.id,
      factEncrypted: BYTES,
      category: "goal",
      sourceConversationId: conversation.id,
    },
  });
  await prisma.inboundDocument.create({
    data: {
      userId: user.id,
      mimeType: "image/png",
      byteSize: BYTES.byteLength,
      contentEncrypted: BYTES,
      summaryEncrypted: BYTES,
      summaryState: "READY",
    },
  });
  return user;
}

async function snapshot(userId: string) {
  const prisma = getPrismaClient();
  const [
    user,
    notes,
    narratives,
    reaction,
    workouts,
    conversations,
    facts,
    docs,
  ] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        insightsCachedText: true,
        insightsCachedAt: true,
        insightsSnapshotHash: true,
      },
    }),
    prisma.insightStatusCache.count({ where: { userId } }),
    prisma.insightNarrative.findMany({
      where: { userId },
      select: { providerType: true },
    }),
    prisma.arrivalReaction.findFirstOrThrow({
      where: { userId },
      select: { lineEncrypted: true, generatedAt: true },
    }),
    prisma.workoutInsight.count({ where: { userId } }),
    prisma.coachConversation.findMany({
      where: { userId },
      select: { summaryEncrypted: true },
    }),
    prisma.coachFact.count({ where: { userId } }),
    prisma.inboundDocument.findMany({
      where: { userId },
      select: { summaryEncrypted: true },
    }),
  ]);
  return {
    user,
    notes,
    narratives,
    reaction,
    workouts,
    conversations,
    facts,
    docs,
  };
}

describe("withdrawing the analysis consent", () => {
  it("deletes every regenerable text and keeps the person's own records", async () => {
    const user = await seed("purge-all", ["ai_full"]);

    const result = await withdrawConsent(user.id, ["ai_full"]);

    expect(result.revoked.map((r) => r.kind)).toEqual(["ai_full"]);
    expect(result.purged).toEqual({
      statusNotes: 2,
      briefing: 1,
      narratives: 1,
      reactionLines: 1,
      workoutParagraphs: 1,
    });

    const after = await snapshot(user.id);
    expect(after.user).toEqual({
      insightsCachedText: null,
      insightsCachedAt: null,
      insightsSnapshotHash: null,
    });
    expect(after.notes).toBe(0);
    expect(after.narratives).toEqual([{ providerType: "deterministic" }]);
    // The marker stays and stays "generated", so nothing writes it again.
    expect(after.reaction.lineEncrypted).toBeNull();
    expect(after.reaction.generatedAt).not.toBeNull();
    expect(after.workouts).toBe(0);
    // The person's own records.
    expect(after.conversations).toHaveLength(1);
    expect(after.conversations[0].summaryEncrypted).not.toBeNull();
    expect(after.facts).toBe(1);
    expect(after.docs[0].summaryEncrypted).not.toBeNull();

    const receipts = await getPrismaClient().consentReceipt.findMany({
      where: { userId: user.id },
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].revokedAt).not.toBeNull();
  });

  it("is atomic: a failing purge leaves the receipt active and every row in place", async () => {
    const user = await seed("purge-atomic", ["ai_insights_only"]);
    const before = await snapshot(user.id);

    await expect(
      withdrawConsent(
        user.id,
        ["ai_insights_only"],
        new Date(),
        async (tx, id) => {
          // Do part of the work, then fail: the part must roll back too.
          await purgeRegenerableAiText(tx, id);
          throw new Error("purge failed");
        },
      ),
    ).rejects.toThrow("purge failed");

    const receipt = await getPrismaClient().consentReceipt.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(receipt.revokedAt).toBeNull();
    expect(await snapshot(user.id)).toEqual(before);
  });

  it("deletes nothing while another receipt still covers the analysis", async () => {
    const user = await seed("purge-covered", ["ai_full", "ai_insights_only"]);
    const before = await snapshot(user.id);

    const result = await withdrawConsent(user.id, ["ai_full"]);

    expect(result.purged).toBeNull();
    expect(await snapshot(user.id)).toEqual(before);
  });

  it("deletes nothing for a withdrawal of the Coach or extraction consent alone", async () => {
    const user = await seed("purge-other", ["ai_coach", "ai_extraction"]);
    const before = await snapshot(user.id);

    const result = await withdrawConsent(user.id, [
      "ai_coach",
      "ai_extraction",
    ]);

    expect(result.revoked).toHaveLength(2);
    expect(result.purged).toBeNull();
    expect(await snapshot(user.id)).toEqual(before);
  });

  it("touches no other account", async () => {
    const user = await seed("purge-me", ["ai_full"]);
    const other = await seed("purge-other-account", ["ai_full"]);
    const otherBefore = await snapshot(other.id);

    await withdrawConsent(user.id, ["ai_full"]);

    expect(await snapshot(other.id)).toEqual(otherBefore);
  });
});

describe("a revoked extraction receipt wins over the auto-read toggle", () => {
  it("refuses external document egress once the receipt is revoked, toggle still on", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "k1-toggle",
        email: "k1-toggle@example.test",
        documentsAutoAiRead: true,
      },
    });
    await prisma.consentReceipt.create({
      data: {
        userId: user.id,
        kind: "ai_extraction",
        artefact: "{}",
        signedAt: new Date(),
      },
    });
    const { aiEgressRefusal } = await import("@/lib/ai/capabilities/egress");

    expect(await aiEgressRefusal("documentAi", user.id, ["codex"])).toBeNull();

    await withdrawConsent(user.id, ["ai_extraction"]);

    const refusal = await aiEgressRefusal("documentAi", user.id, ["codex"]);
    expect(refusal?.reason).toBe("consent_required");
    // A local pick never leaves the machine and stays admitted.
    expect(await aiEgressRefusal("documentAi", user.id, ["local"])).toBeNull();
  });
});
