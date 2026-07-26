import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { getIntegrationStatus } from "@/lib/integrations/status";
import {
  INTEGRATION_CADENCE,
  resolveSyncVerdict,
} from "@/lib/integrations/sync-verdict";

/**
 * Nightscout connection status for the current user (v1.17.0).
 *
 * `configured` is whether an instance URL is stored (the connect marker — a
 * fully-public instance has no token). The ledger snapshot (state /
 * lastSuccessAt / lastError) comes off the shared `nightscout` IntegrationKey
 * so the Settings card surfaces the same connected / error / parked pill the
 * other integrations use. The stored URL is echoed back (host only is enough
 * for the card, but the URL is the user's own and not a secret); the token is
 * NEVER returned.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "nightscout.status" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      nightscoutUrlEncrypted: true,
      nightscoutTokenEncrypted: true,
      nightscoutAllowPrivateHost: true,
    },
  });

  const configured = !!dbUser?.nightscoutUrlEncrypted;

  if (!configured) {
    return apiSuccess({ connected: false, configured: false });
  }

  const status = await getIntegrationStatus(user.id, "nightscout");

  return apiSuccess({
    connected: true,
    configured: true,
    hasToken: !!dbUser?.nightscoutTokenEncrypted,
    allowPrivateHost: dbUser?.nightscoutAllowPrivateHost ?? false,
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
      cadence: INTEGRATION_CADENCE["nightscout"],
    }),
  });
});
