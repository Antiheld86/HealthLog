/**
 * Shared user discovery for the nightly 02:xx per-metric status crons
 * (general / blood-pressure / weight / pulse / bmi / medication-
 * compliance / mood).
 *
 * Before this module each cron iterated EVERY user row: accounts that
 * disabled the coach surface (`disableCoach`) and operator-disabled
 * deployments (assistant kill-switch) still paid one generator pass per
 * user per night, and users the 04:30 `insight-pregenerate` cron was
 * going to re-warm anyway were generated twice.
 *
 * Division of nightly labour (documented here once, referenced by the
 * handlers):
 *
 *   - 02:xx status crons → users WITHOUT a comprehensive-pregenerate
 *     claim: no configured provider, or a comprehensive cache fresher
 *     than `PREGENERATE_STALE_MS` so the 04:30 pass will skip them —
 *     their per-status caches still age out daily and only these crons
 *     re-fill them. With the one-hour threshold this cohort is, in
 *     practice, the provider-less accounts.
 *   - 04:30 insight-pregenerate → the rest: coach-enabled users with a
 *     configured provider and a comprehensive cache older than
 *     `PREGENERATE_STALE_MS`. That pass regenerates the comprehensive
 *     insight AND force-warms every per-status cache, so a 02:xx
 *     generation for those users would be evicted and redone two hours
 *     later.
 *
 * Gates, in order:
 *   1. Operator kill-switch via `getAssistantFlags()` — the same source
 *      `insight-pregenerate` uses. The status cards belong to the
 *      `insightStatus` surface, so that flag (which the master assistant
 *      switch also forces off) gates the whole pass.
 *   2. Per-user `disableCoach: false` — a user who disabled the AI
 *      surface gets no nightly generation.
 *   3. The pregenerate-candidate skip described above (only when the
 *      `briefing` surface is enabled — when it is off the 04:30 pass
 *      no-ops, so the 02:xx crons must keep covering everyone).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getAssistantFlags } from "@/lib/feature-flags";
import { userRowHasProviderCredential } from "@/lib/ai/provider";
import { PREGENERATE_STALE_MS } from "@/lib/jobs/insight-pregenerate";

export interface StatusCronCandidate {
  id: string;
  locale: string | null;
}

export async function findStatusCronCandidates(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<StatusCronCandidate[]> {
  const flags = await getAssistantFlags();
  if (!flags.insightStatus) return [];

  const users = await prisma.user.findMany({
    where: { disableCoach: false },
    select: {
      id: true,
      locale: true,
      insightsCachedAt: true,
      // Credential-presence columns for the pregenerate-candidate skip —
      // evaluated locally, never decrypted.
      aiProvider: true,
      aiProviderChain: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
      aiBaseUrl: true,
      aiModel: true,
      aiCompatBaseUrl: true,
      aiCompatModel: true,
      codexConnectionStatus: true,
      codexAccessTokenEncrypted: true,
      codexRefreshTokenEncrypted: true,
    },
  });
  if (users.length === 0) return [];

  // When the briefing surface is off the 04:30 pregenerate pass no-ops,
  // so no user has a comprehensive claim and the 02:xx crons keep all.
  if (!flags.briefing) {
    return users.map((u) => ({ id: u.id, locale: u.locale }));
  }

  // One presence read for the operator's shared key covers the cohort.
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { adminAiKeyEncrypted: true },
  });
  const adminKeyConfigured = !!settings?.adminAiKeyEncrypted;

  const staleBefore = now.getTime() - PREGENERATE_STALE_MS;
  return users
    .filter((u) => {
      const cacheStale =
        !u.insightsCachedAt || u.insightsCachedAt.getTime() < staleBefore;
      const isPregenerateCandidate =
        cacheStale && userRowHasProviderCredential(u, adminKeyConfigured);
      return !isPregenerateCandidate;
    })
    .map((u) => ({ id: u.id, locale: u.locale }));
}
