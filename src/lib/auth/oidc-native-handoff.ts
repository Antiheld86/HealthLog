/**
 * Native OIDC SSO session handoff (iOS#49).
 *
 * The web OIDC flow (`/api/auth/oidc/login` → IdP → `/api/auth/oidc/callback`)
 * ends in a session cookie. The native app is a Bearer-transport client and can
 * never consume a cookie. This module bridges the two: the callback mints a
 * one-time, PKCE-locked handoff code that rides ONLY the custom-scheme redirect
 * back to the app; the app exchanges it at `POST /api/auth/oidc/native/token`
 * for the standard native token bundle.
 *
 * v1.32.11 — the mint/consume core moved to `./native-handoff.ts` so the
 * first-party web-handoff login (iOS #65) shares the exact same single-use /
 * short-TTL / PKCE-S256 / replay-revoke semantics. This module keeps the OIDC
 * flow's compile-time constant + its callback builder and re-exports the shared
 * core so every existing OIDC call site is unchanged. The OIDC leg is `flow:
 * "oidc"`, which is the shared core's default — so nothing in the OIDC callback
 * or token route had to change.
 */
import {
  buildHandoffCallbackUrl,
  NATIVE_HANDOFF_TTL_MS,
} from "@/lib/auth/native-handoff";

/**
 * The ONLY callback target for the OIDC native flow. Compiled-in, not operator-
 * or client-supplied. The `healthlog` scheme is an iOS-app dependency the app
 * must register. If the shipped app owns a different scheme, this constant is
 * corrected once before release; it remains a compile-time constant either way.
 */
export const NATIVE_OIDC_REDIRECT_URI = "healthlog://oidc-callback";

/** Back-compat alias — the OIDC leg's TTL is the shared handoff TTL. */
export const OIDC_NATIVE_HANDOFF_TTL_MS = NATIVE_HANDOFF_TTL_MS;

/**
 * Build the OIDC native callback redirect from the compiled-in constant plus
 * query-escaped params only — nothing the client sends is ever echoed into a
 * `Location` header on the native branch.
 */
export function buildNativeCallbackUrl(params: Record<string, string>): string {
  return buildHandoffCallbackUrl(NATIVE_OIDC_REDIRECT_URI, params);
}

// Re-export the shared mint/consume core so the OIDC callback + token route
// keep importing from here unchanged.
export {
  mintNativeHandoff,
  consumeNativeHandoff,
  stampIssuedRefreshToken,
} from "@/lib/auth/native-handoff";
