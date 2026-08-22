/**
 * GET /api/auth/native/login
 *
 * Authorize entry for the first-party web-handoff login (iOS #65). The iOS app,
 * on a self-hosted domain, opens this URL inside an `ASWebAuthenticationSession`
 * with its PKCE `code_challenge`. This endpoint validates the challenge, folds
 * it plus a DB-clock `startedAt` into an AES-256-GCM state cookie, and redirects
 * to the instance's own web login at `/auth/login?flow=native` so the login runs
 * in the real web origin (fixing password autofill + passkeys for self-hosters).
 *
 * Pre-auth surface: writes NO database rows (anonymous flooding costs the caller
 * a cookie in their own jar). Every error branch redirects to the compiled-in
 * custom scheme with a machine-readable `error=<reason>` — an error redirect
 * carries no code or session, so it leaks nothing.
 */
import { NextRequest, NextResponse } from "next/server";
import { relativeRedirect } from "@/lib/http/relative-redirect";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { isValidChallenge } from "@/lib/mcp/oauth/pkce";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import {
  NATIVE_HANDOFF_STATE_COOKIE,
  NATIVE_HANDOFF_STATE_COOKIE_PATH,
  NATIVE_HANDOFF_STATE_TTL_MS,
  buildWebHandoffCallbackUrl,
  encodeNativeHandoffState,
  nativeHandoffDbNow,
  type NativeHandoffErrorReason,
} from "@/lib/auth/native-web-handoff";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (req: NextRequest) => {
  annotate({ action: { name: "auth.native.login" } });

  // The whole route is a native start — every failure redirects to the scheme.
  const loginError = (reason: NativeHandoffErrorReason): NextResponse =>
    NextResponse.redirect(buildWebHandoffCallbackUrl({ error: reason }));

  const rl = await checkAuthSurfaceRateLimit(
    req,
    "auth:native:login",
    10,
    15 * 60 * 1000,
  );
  if (!rl.allowed) return loginError("rate_limited");

  // A native start MUST carry a valid S256 challenge (43–128 chars). `plain` is
  // structurally unsupported — the exchange only ever verifies S256.
  const appCodeChallenge = req.nextUrl.searchParams.get("code_challenge");
  if (!isValidChallenge(appCodeChallenge)) {
    annotate({ meta: { reason: "invalid_native_request" } });
    return loginError("invalid_request");
  }

  // Stamp `startedAt` from the DB clock so it is directly comparable to
  // `Session.createdAt` (also DB-side) at completion, with no app/DB skew.
  const startedAt = await nativeHandoffDbNow();

  const response = relativeRedirect("/auth/login?flow=native");
  response.cookies.set(
    NATIVE_HANDOFF_STATE_COOKIE,
    encodeNativeHandoffState({
      appCodeChallenge,
      startedAt: startedAt.toISOString(),
    }),
    {
      httpOnly: true,
      secure: shouldEmitSecureCookie(),
      // The completion is a top-level GET navigated by the page after login;
      // Lax carries the cookie on that same-site top-level navigation.
      sameSite: "lax",
      maxAge: Math.floor(NATIVE_HANDOFF_STATE_TTL_MS / 1000),
      // Only the completion endpoint ever reads it — the delete repeats this path.
      path: NATIVE_HANDOFF_STATE_COOKIE_PATH,
    },
  );
  return response;
});
