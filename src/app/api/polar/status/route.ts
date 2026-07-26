import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { getPolarClientCredentials } from "@/lib/polar/credentials";
import { getIntegrationStatus } from "@/lib/integrations/status";
import {
  INTEGRATION_CADENCE,
  resolveSyncVerdict,
} from "@/lib/integrations/sync-verdict";

/**
 * v1.17.0 (F4) — Polar connection status for the current user.
 *
 * `available` reports whether usable OAuth credentials resolve for this user —
 * per-user BYO keys (v1.17.1) first, then the shared env app — so the card can
 * grey out the connect button when neither is set. `hasOwnCredentials` reports
 * whether the user has stored their own BYO pair (drives the saved-placeholder
 * UI). `connected` is whether a token is stored. The ledger snapshot (state /
 * lastSuccessAt / lastError) comes off the shared `polar` IntegrationKey. The
 * access token, member id, and client secret are NEVER returned.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "polar.status" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      polarAccessTokenEncrypted: true,
      polarClientIdEncrypted: true,
      polarClientSecretEncrypted: true,
    },
  });

  const available = !!(await getPolarClientCredentials(user.id));
  const connected = !!dbUser?.polarAccessTokenEncrypted;
  const hasOwnCredentials =
    !!dbUser?.polarClientIdEncrypted && !!dbUser?.polarClientSecretEncrypted;

  if (!connected) {
    return apiSuccess({
      connected: false,
      configured: false,
      available,
      hasOwnCredentials,
    });
  }

  const status = await getIntegrationStatus(user.id, "polar");

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
      cadence: INTEGRATION_CADENCE["polar"],
    }),
  });
});
