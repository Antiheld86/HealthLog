import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { getOuraClientCredentials } from "@/lib/oura/credentials";
import { getIntegrationStatus } from "@/lib/integrations/status";
import {
  INTEGRATION_CADENCE,
  resolveSyncVerdict,
} from "@/lib/integrations/sync-verdict";

/**
 * v1.17.0 (F4) — Oura connection status for the current user.
 *
 * `available` reports whether usable OAuth credentials resolve for this user —
 * per-user BYO keys (v1.17.1) first, then the shared env app.
 * `hasOwnCredentials` reports whether the user has stored their own BYO pair.
 * `connected` is whether a token is stored. The ledger snapshot comes off the
 * shared `oura` IntegrationKey. The access / refresh tokens + client secret are
 * NEVER returned.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "oura.status" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      ouraAccessTokenEncrypted: true,
      ouraClientIdEncrypted: true,
      ouraClientSecretEncrypted: true,
    },
  });

  const available = !!(await getOuraClientCredentials(user.id));
  const connected = !!dbUser?.ouraAccessTokenEncrypted;
  const hasOwnCredentials =
    !!dbUser?.ouraClientIdEncrypted && !!dbUser?.ouraClientSecretEncrypted;

  if (!connected) {
    return apiSuccess({
      connected: false,
      configured: false,
      available,
      hasOwnCredentials,
    });
  }

  const status = await getIntegrationStatus(user.id, "oura");

  return apiSuccess({
    connected: true,
    configured: true,
    available,
    hasOwnCredentials,
    state: status.state,
    lastSuccessAt: status.lastSuccessAt,
    lastAttemptAt: status.lastAttemptAt,
    lastError: status.lastError,
    // `connected: true` here means "a connection exists", not "it is working"
    // — a pipe dead for a fortnight still answers true. The verdict is the
    // liveness truth, resolved by the same rule the Settings envelope uses so
    // this route cannot drift into a second opinion.
    syncHealth: resolveSyncVerdict({
      connected: true,
      configured: true,
      state: status.state,
      lastSuccessAt: status.lastSuccessAt,
      lastAttemptAt: status.lastAttemptAt,
      failingSinceAt: status.failingSince,
      cadence: INTEGRATION_CADENCE["oura"],
    }),
  });
});
