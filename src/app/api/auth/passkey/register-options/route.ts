import { NextRequest } from "next/server";
import {
  createAuthenticationOptions,
  createRegistrationOptions,
  verifyAuthentication,
} from "@/lib/auth/passkey";
import {
  createMfaAuthenticationOptions,
  verifyMfaAuthentication,
} from "@/lib/auth/mfa/webauthn";
import { verifyMfaFactor } from "@/lib/auth/mfa/verify-factor";
import { verifyPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import { apiError, apiSuccess, safeJson } from "@/lib/api-response";
import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { stepUpMintSchema } from "@/lib/validations/step-up";

const proofRequired = () =>
  apiError("Fresh existing-factor proof required", 401);

export const POST = apiHandler(async (request: NextRequest) => {
  const { user, session } = await requireCookieAuth();

  if (!request.headers.get("content-type")?.includes("application/json")) {
    return proofRequired();
  }

  const { data: body, error: jsonError } = await safeJson<
    Record<string, unknown>
  >(request, { maxBytes: 64 * 1024 });
  if (jsonError) return proofRequired();

  // Begin an assertion ceremony without beginning registration. This lets the
  // browser re-prove a passkey or second-factor security key before this route
  // creates any enrollment challenge.
  if (
    Object.keys(body).length === 1 &&
    (body.method === "passkey" || body.method === "webauthn")
  ) {
    const result =
      body.method === "passkey"
        ? await createAuthenticationOptions(user.id)
        : await createMfaAuthenticationOptions(user.id);
    if (!result) {
      return apiError("That verification method is unavailable", 409);
    }
    return apiSuccess({ ...result, reauth: true });
  }

  const parsed = stepUpMintSchema.safeParse(body);
  if (!parsed.success) return proofRequired();

  let proved = false;

  if (parsed.data.method === "password") {
    proved = Boolean(
      user.passwordHash &&
      (await verifyPassword(user.passwordHash, parsed.data.password)),
    );
  } else if (parsed.data.method === "totp") {
    const result = await verifyMfaFactor(user, "totp", parsed.data.code);
    proved = result.ok;
  } else {
    const expectedType =
      parsed.data.method === "passkey"
        ? "authentication"
        : "mfa_authentication";
    const challenge = await prisma.authChallenge.findUnique({
      where: { id: parsed.data.challengeId },
      select: { userId: true, type: true },
    });

    if (challenge?.userId === user.id && challenge.type === expectedType) {
      try {
        if (parsed.data.method === "passkey") {
          const result = await verifyAuthentication(
            parsed.data.challengeId,
            parsed.data.credential,
          );
          proved =
            result.verification.verified && result.passkey.userId === user.id;
        } else {
          proved = await verifyMfaAuthentication(
            parsed.data.challengeId,
            user.id,
            parsed.data.credential,
          );
        }
      } catch {
        proved = false;
      }
    }
  }

  if (!proved) return proofRequired();

  // A strong existing factor refreshes the session's MFA stamp. Password proof
  // deliberately clears it: registration is authorized by this single-use,
  // session-bound challenge but cannot upgrade password-only authentication.
  await prisma.session.update({
    where: { id: session.id },
    data: {
      mfaVerifiedAt: parsed.data.method === "password" ? null : new Date(),
    },
  });

  const { options, challengeId } = await createRegistrationOptions(
    user.id,
    user.email ?? user.username,
    session.id,
  );

  annotate({ action: { name: "auth.passkey.register-options" } });

  return apiSuccess({ options, challengeId });
});
