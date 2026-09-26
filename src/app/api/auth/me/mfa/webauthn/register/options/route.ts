/**
 * POST /api/auth/me/mfa/webauthn/register/options
 *
 * Begin registering a WebAuthn security key as a second factor. Takes a cookie
 * session or a Bearer token presenting a single-use step-up elevation; a token
 * on its own can never enrol MFA. Returns the SimpleWebAuthn creation options +
 * the server-issued challenge id to present back at /register/verify.
 *
 * The cookie arm additionally passes `checkCookieEnrollmentProof`: a session
 * alone cannot add a security key, for the same reason it cannot enroll TOTP —
 * the new key would satisfy every step-up gate from then on.
 */
import { apiHandler, requireMfaManagementAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { checkCookieEnrollmentProof } from "@/lib/auth/existing-factor-proof";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { createMfaRegistrationOptions } from "@/lib/auth/mfa/webauthn";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (req: Request) => {
  const auth = await requireMfaManagementAuth();
  const { user } = auth;

  const rl = await checkRateLimit(
    `mfa:webauthn:register:${user.id}`,
    10,
    15 * 60 * 1000,
  );
  if (!rl.allowed) {
    const res = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      res.headers.set(k, v);
    }
    return res;
  }

  if (auth.transport === "cookie") {
    const refusal = await checkCookieEnrollmentProof({
      user,
      sessionId: auth.session.id,
      request: req,
      ipAddress: getClientIp(req),
      stage: "security_key_enroll",
    });
    if (refusal) return refusal;
  }

  await auth.commitElevation();

  const { options, challengeId } = await createMfaRegistrationOptions(
    user.id,
    user.email ?? user.username,
  );

  annotate({ action: { name: "auth.mfa.webauthn.register-options" } });

  return apiSuccess({ options, challengeId });
});
