import { prisma } from "@/lib/db";
import { apiHandler } from "@/lib/api-handler";
import { getSession } from "@/lib/auth/session";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { exchangeCode } from "@/lib/strava/client";
import { getStravaClientCredentials } from "@/lib/strava/credentials";
import {
  oauthStateCookieName,
  stateMatchesCookie,
  verifySignedState,
} from "@/lib/oauth/signed-state";
import { markReconnected } from "@/lib/integrations/status";
import { STRAVA_BACKFILL_QUEUE } from "@/lib/jobs/strava-backfill";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { NextRequest, NextResponse } from "next/server";

/**
 * v1.28.x — OAuth callback from Strava.
 *
 * Identity + CSRF mirror the Polar / Oura callbacks: the `state` param is a
 * stateless HMAC-signed token, enforced as a byte-exact double-submit against
 * the httpOnly cookie AND verified for signature / expiry / `strava` provider
 * binding. The `userId` is read from inside the verified token, cross-checked
 * against the web session when present.
 *
 * On success: exchange the code, persist the encrypted access + rotated refresh
 * token + the numeric athlete id on `User`, clear any prior reauth state, and
 * redirect back to Settings. A re-auth that returns a DIFFERENT athlete id than
 * the one already stored is rejected (`cross_user`) so a second Strava account
 * cannot silently overwrite the first's grant.
 */
const ERR = (reason: string) =>
  NextResponse.redirect(
    new URL(
      `/settings/integrations?strava=error&reason=${reason}`,
      process.env.NEXT_PUBLIC_APP_URL!,
    ),
  );

export const GET = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "strava.callback" } });

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const cookieState = request.cookies.get(
    oauthStateCookieName("strava"),
  )?.value;

  if (!stateMatchesCookie(state, cookieState)) {
    annotate({ meta: { reason: "csrf1" } });
    return ERR("csrf1");
  }

  const verified = verifySignedState("strava", state);
  if (!verified) {
    annotate({ meta: { reason: "state" } });
    return ERR("state");
  }
  const userId = verified.userId;

  const evt = getEvent();
  if (evt) evt.setAuth({ user_id: userId, auth_method: "session" });

  const sessionData = await getSession();
  if (sessionData && sessionData.user.id !== userId) {
    annotate({ meta: { reason: "cross_user" } });
    return ERR("cross_user");
  }

  if (!code) return ERR("nocode");

  try {
    const creds = await getStravaClientCredentials(userId);
    if (!creds) return ERR("nocreds");

    const tokens = await exchangeCode(code, creds);

    const athleteId =
      typeof tokens.athlete?.id === "number" ? String(tokens.athlete.id) : null;

    // Reject a re-auth that swaps the connected Strava account. A different
    // athlete id than the one already pinned means a second account is trying
    // to overwrite the first's grant.
    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { stravaAthleteId: true },
    });
    if (
      existing?.stravaAthleteId &&
      athleteId &&
      existing.stravaAthleteId !== athleteId
    ) {
      annotate({ meta: { reason: "cross_user" } });
      return ERR("cross_user");
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        stravaAccessTokenEncrypted: encrypt(tokens.access_token),
        stravaRefreshTokenEncrypted: encrypt(tokens.refresh_token),
        stravaAthleteId: athleteId,
      },
    });

    await auditLog("strava.connect", { userId });
    await markReconnected(userId, "strava");

    // Enqueue the self-converging history backfill at connect time so deep
    // history lands within the hour instead of waiting for the next worker
    // reboot. Best-effort: the boot-time discovery query
    // (`stravaBackfillCompletedAt IS NULL`) is the safety net, so a missing
    // boss instance here never strands the connection. Mirrors the WHOOP /
    // Fitbit callback enqueue.
    const boss = getGlobalBoss();
    if (boss) {
      await boss
        .send(STRAVA_BACKFILL_QUEUE, {
          userId,
          enqueuedAt: new Date().toISOString(),
        })
        .catch((err) =>
          getEvent()?.addWarning(`strava-backfill enqueue failed: ${err}`),
        );
    }

    const response = NextResponse.redirect(
      new URL(
        "/settings/integrations?strava=connected",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
    response.cookies.delete(oauthStateCookieName("strava"));
    return response;
  } catch (err) {
    getEvent()?.setError(err);
    return ERR("token");
  }
});
