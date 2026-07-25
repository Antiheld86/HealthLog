import { prisma } from "@/lib/db";
import { apiHandler } from "@/lib/api-handler";
import { getSession } from "@/lib/auth/session";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { exchangeCode, registerUser } from "@/lib/polar/client";
import { getPolarClientCredentials } from "@/lib/polar/credentials";
import {
  oauthStateCookieName,
  stateMatchesCookie,
  verifySignedState,
} from "@/lib/oauth/signed-state";
import { markReconnected } from "@/lib/integrations/status";
import { POLAR_SYNC_QUEUE } from "@/lib/jobs/integration-poll-queues";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { NextRequest, NextResponse } from "next/server";

/**
 * v1.17.0 (F4) — OAuth callback from Polar AccessLink.
 *
 * Identity + CSRF: the `state` URL param is a stateless HMAC-signed token. The
 * callback enforces (1) the param equals the httpOnly cookie byte-for-byte
 * (double-submit), and (2) the signature + expiry + `polar` provider binding
 * are valid. The `userId` is read from INSIDE the verified token — tamper-
 * evident — so identity never comes from the ambient session. When a web
 * session cookie is also present we cross-check it matches, so a logged-in user
 * can't complete another user's in-flight handshake.
 *
 * On success: exchange the code (Basic-auth), register the user with the Polar
 * app, persist the encrypted access token + member id on `User`, clear any
 * prior reauth state, and redirect back to Settings.
 */
const ERR = (reason: string) =>
  NextResponse.redirect(
    new URL(
      `/settings/integrations?polar=error&reason=${reason}`,
      process.env.NEXT_PUBLIC_APP_URL!,
    ),
  );

export const GET = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "polar.callback" } });

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const cookieState = request.cookies.get(oauthStateCookieName("polar"))?.value;

  // CSRF double-submit: the URL state must equal the cookie (constant-time).
  if (!stateMatchesCookie(state, cookieState)) {
    annotate({ meta: { reason: "csrf1" } });
    return ERR("csrf1");
  }

  // Verify signature + expiry + provider binding; userId rides inside.
  const verified = verifySignedState("polar", state);
  if (!verified) {
    annotate({ meta: { reason: "state" } });
    return ERR("state");
  }
  const userId = verified.userId;

  const evt = getEvent();
  if (evt) evt.setAuth({ user_id: userId, auth_method: "session" });

  // Optional session cross-check when a web session is present.
  const sessionData = await getSession();
  if (sessionData && sessionData.user.id !== userId) {
    annotate({ meta: { reason: "cross_user" } });
    return ERR("cross_user");
  }

  if (!code) return ERR("nocode");

  try {
    const creds = await getPolarClientCredentials(userId);
    if (!creds) return ERR("nocreds");

    const tokens = await exchangeCode(code, creds);
    // Guard against an off-spec token body without `x_user_id`: persisting the
    // string "undefined" as the member id would break every later data read
    // (`/v3/users/undefined/...`) with no clear cause.
    if (
      typeof tokens.x_user_id !== "number" ||
      !Number.isFinite(tokens.x_user_id)
    ) {
      return ERR("token");
    }
    const polarUserId = String(tokens.x_user_id);

    // Register the user with the Polar app (idempotent; 409 = already linked).
    await registerUser(tokens.access_token, polarUserId);

    await prisma.user.update({
      where: { id: userId },
      data: {
        polarAccessTokenEncrypted: encrypt(tokens.access_token),
        // Polar issues no refresh token, so no refresh column is stored.
        polarUserIdEncrypted: encrypt(polarUserId),
      },
    });

    await auditLog("polar.connect", { userId });
    await markReconnected(userId, "polar");

    // Start the first sync now instead of leaving the user staring at an empty
    // card until the next hourly tick. Best-effort by design: the hourly cron
    // remains the safety net, so a missing boss instance must never strand the
    // redirect.
    const boss = getGlobalBoss();
    if (boss) {
      await boss
        .send(POLAR_SYNC_QUEUE, { userId })
        .catch((err) =>
          getEvent()?.addWarning(`polar-sync connect enqueue failed: ${err}`),
        );
    }

    const response = NextResponse.redirect(
      new URL(
        "/settings/integrations?polar=connected",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
    response.cookies.delete(oauthStateCookieName("polar"));
    return response;
  } catch (err) {
    getEvent()?.setError(err);
    return ERR("token");
  }
});
