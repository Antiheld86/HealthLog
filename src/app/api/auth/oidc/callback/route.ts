import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import {
  createSession,
  validateSessionFromCookieValue,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/session";
import { recordSignInDevice } from "@/lib/auth/login-alert";
import {
  deriveUniqueUsername,
  discoverOidcMetadata,
  exchangeCodeForTokens,
  fetchUserinfoEmail,
  getOidcConfig,
  getOidcRedirectUri,
  oidcAppUrl,
  verifyIdToken,
} from "@/lib/auth/oidc";
import {
  OIDC_MFA_COOKIE,
  OIDC_MFA_COOKIE_PATH,
  OIDC_MFA_TTL_MS,
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_PATH,
} from "@/lib/auth/oidc-cookie";
import { createMfaChallenge } from "@/lib/auth/mfa/challenge";
import { syncMfaEnrollCookie } from "@/lib/auth/mfa-enrollment";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { resolveServerDefaultTimezone } from "@/lib/tz/resolver";
import {
  buildNativeCallbackUrl,
  mintNativeHandoff,
} from "@/lib/auth/oidc-native-handoff";
import { setPendingLinkCookie } from "@/lib/auth/oidc-pending-link";

const LOGIN_ERROR_URL = "/auth/login";

function errorRedirect(reason: string): NextResponse {
  const response = NextResponse.redirect(
    oidcAppUrl(`${LOGIN_ERROR_URL}?error=${reason}`),
  );
  deleteStateCookie(response);
  return response;
}

/**
 * The state cookie is set with `path: "/api/auth/oidc"`; the delete must
 * repeat that path (RFC 6265 keys cookies by name+domain+path — a bare
 * delete would target `/` and never match, leaving the single-use blob
 * alive for the rest of its TTL).
 */
function deleteStateCookie(response: NextResponse): void {
  response.cookies.delete({
    name: OIDC_STATE_COOKIE,
    path: OIDC_STATE_COOKIE_PATH,
  });
}

/**
 * Closed set of RFC 6749 §4.1.2.1 / OIDC Core §3.1.2.6 authorization error
 * codes. The wide-event meta only ever carries a member of this set (or
 * "other") — never the raw, attacker-influenceable query value.
 */
const KNOWN_IDP_ERROR_CODES = new Set([
  "access_denied",
  "invalid_request",
  "unauthorized_client",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "interaction_required",
  "login_required",
  "account_selection_required",
  "consent_required",
  "invalid_request_uri",
  "invalid_request_object",
  "request_not_supported",
  "request_uri_not_supported",
  "registration_not_supported",
]);

interface StoredOidcState {
  state: string;
  nonce: string;
  codeVerifier: string;
  next: string;
  /**
   * v1.30.x — set only when the login GET carried `client=native`. When true
   * the callback mints a handoff code (or MFA ticket) and redirects to the
   * custom scheme instead of minting a session. Both fields live ONLY inside
   * the AES-256-GCM blob, so they are tamper-authenticated: a network attacker
   * or the IdP cannot flip a web login into a native one or swap the app
   * challenge.
   */
  native?: boolean;
  /** The app's S256 PKCE challenge, bound at login; verified at the exchange. */
  appCodeChallenge?: string;
}

function isStoredOidcState(value: unknown): value is StoredOidcState {
  const v = value as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof v.state !== "string" ||
    typeof v.nonce !== "string" ||
    typeof v.codeVerifier !== "string" ||
    typeof v.next !== "string"
  ) {
    return false;
  }
  // Optional native fields: when present they must be the right shape, and a
  // native start MUST carry the challenge the exchange verifies against.
  if (v.native !== undefined) {
    if (v.native !== true) return false;
    if (typeof v.appCodeChallenge !== "string") return false;
  }
  return true;
}

/**
 * OIDC callback. Must work with NO existing session — this route
 * authenticates the user in the first place, unlike the per-account
 * integration callbacks (Withings/Polar/etc.) which all require
 * `requireAuth()`. Every failure branch redirects to `/auth/login?error=...`
 * (never JSON — this is a top-level browser navigation) and deletes the
 * single-use state cookie, mirroring `src/app/api/withings/callback/route.ts`.
 */
export const GET = apiHandler(async (req: NextRequest) => {
  annotate({ action: { name: "auth.oidc.callback" } });

  // Decrypt the single-use state blob FIRST. The `native` flag lives inside the
  // AES-256-GCM payload (tamper-authenticated), so decrypting it up front lets
  // every post-decrypt error branch redirect to the custom scheme instead of
  // the web login page — the app parses `?error=<reason>` and never lands on a
  // dead web page. A missing/undecryptable blob leaves `stored` null (isNative
  // false) and those branches fall back to the web redirect by construction.
  const rawCookie = req.cookies.get(OIDC_STATE_COOKIE)?.value;
  let stored: StoredOidcState | null = null;
  if (rawCookie) {
    try {
      const parsed: unknown = JSON.parse(decrypt(rawCookie));
      if (isStoredOidcState(parsed)) stored = parsed;
    } catch {
      stored = null;
    }
  }
  const isNative = stored?.native === true;

  // Native-aware error redirect: the custom scheme for a decrypted native flow,
  // the web login page otherwise. Deletes the single-use state cookie either
  // way. An error redirect carries no code, ticket, or session, so routing it
  // to the scheme leaks nothing (spec §1).
  const failRedirect = (reason: string): NextResponse => {
    if (isNative) {
      const response = NextResponse.redirect(
        buildNativeCallbackUrl({ error: reason }),
      );
      deleteStateCookie(response);
      return response;
    }
    return errorRedirect(reason);
  };

  const config = getOidcConfig();
  if (!config) return failRedirect("oidc_disabled");

  const rl = await checkAuthSurfaceRateLimit(
    req,
    "auth:oidc:callback",
    20,
    15 * 60 * 1000,
  );
  const ip = rl.ip ?? "unknown";
  if (!rl.allowed) return failRedirect("oidc_rate_limited");

  const { searchParams } = req.nextUrl;
  const idpError = searchParams.get("error");
  if (idpError) {
    annotate({
      meta: {
        reason: "idp_denied",
        idpError: KNOWN_IDP_ERROR_CODES.has(idpError) ? idpError : "other",
      },
    });
    return failRedirect("oidc_denied");
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  // Broken round-trip / missing-or-unreadable state blob / CSRF mismatch all
  // resolve to the web `oidc_state` fallback: the flow is fundamentally broken
  // and there is nothing safe to hand the app (spec §1 web-fallback).
  if (!code || !state) return errorRedirect("oidc_state");

  if (!stored) {
    // Defence-in-depth idempotency for a duplicated callback. The single-use
    // state cookie is set with `path: "/api/auth/oidc"` and DELETED by the
    // first callback the moment it succeeds. A second callback for the same
    // sign-in (a client/proxy retry, a double navigation, or the
    // service-worker double-request this release also fixes) therefore arrives
    // with the state cookie already gone — `stored` is null — and, because the
    // first callback set the session, it carries a live session cookie.
    // Redeeming the now-consumed authorization code again fails at the IdP and
    // surfaces `?error=oidc_failed` on a sign-in that actually succeeded. So
    // when a VALIDATED session is present, treat this as a duplicate of a
    // completed login and send the user into the app instead of erroring.
    //
    // Fail-closed is preserved for the real attack case: the code is NEVER
    // exchanged on this branch, and the session is resolved against the
    // database + its expiry (not merely "a cookie is present"). A forged,
    // replayed, or expired state from a caller with no valid session gets the
    // unchanged `oidc_state` error; a caller who already holds their own valid
    // session gains nothing here but a redirect to a page they could already
    // reach — no code redemption, no session mint, no identity change.
    const existingSession = await validateSessionFromCookieValue(
      req.cookies.get(SESSION_COOKIE_NAME)?.value,
    );
    if (existingSession) {
      annotate({ meta: { reason: "duplicate_callback_authenticated" } });
      const response = NextResponse.redirect(oidcAppUrl("/"));
      // The state cookie is already consumed; delete defensively so a stray
      // blob can never outlive this response.
      deleteStateCookie(response);
      return response;
    }
    return errorRedirect("oidc_state");
  }

  // CSRF check — timing-safe, byte-for-byte, mirroring the Withings callback.
  if (
    state.length !== stored.state.length ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(stored.state))
  ) {
    annotate({ meta: { reason: "csrf" } });
    return errorRedirect("oidc_state");
  }

  try {
    const metadata = await discoverOidcMetadata(config);
    const redirectUri = getOidcRedirectUri();

    const tokens = await exchangeCodeForTokens({
      metadata,
      config,
      code,
      codeVerifier: stored.codeVerifier,
      redirectUri,
    });
    if (!tokens.id_token) return failRedirect("oidc_failed");

    const identity = await verifyIdToken({
      metadata,
      config,
      idToken: tokens.id_token,
      nonce: stored.nonce,
    });

    let email = identity.email;
    let emailVerified = identity.emailVerified;
    if (!email && tokens.access_token) {
      const userinfo = await fetchUserinfoEmail({
        metadata,
        accessToken: tokens.access_token,
      });
      email = userinfo.email;
      emailVerified = userinfo.emailVerified;
    }

    // (1) Durable identity match — the (issuer, sub) pair stamped on a
    // previous login, link, or provision. Email is deliberately NOT
    // consulted here: after the stamp it is a display field, so an
    // IdP-side email change can refresh it below but can never re-point
    // the login at a different account.
    let user = await prisma.user.findFirst({
      where: { oidcIssuer: metadata.issuer, oidcSub: identity.sub },
    });

    if (user) {
      // Refresh the display email only — and only from a claim the IdP
      // explicitly marks verified. Skipped when another account already
      // holds the address (`email` is unique); the login itself proceeds
      // either way, keyed by (issuer, sub).
      const displayEmail = email ? email.toLowerCase() : null;
      if (
        displayEmail &&
        emailVerified === true &&
        user.email?.toLowerCase() !== displayEmail
      ) {
        const emailTaken = await prisma.user.findFirst({
          where: {
            email: { equals: displayEmail, mode: "insensitive" },
            NOT: { id: user.id },
          },
          select: { id: true },
        });
        if (!emailTaken) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: { email: displayEmail },
          });
        }
      }
    } else {
      // No stamped identity yet — both remaining paths (link-once,
      // provision) bind this (issuer, sub) to an account keyed by email,
      // so the claim must be explicitly `email_verified: true`. An ABSENT
      // claim is a reject, not a benefit of the doubt: an IdP that does
      // not assert verification cannot anchor a link that later gates a
      // health record.
      if (!email) {
        annotate({ meta: { reason: "no_email" } });
        return failRedirect("oidc_no_email");
      }
      if (emailVerified !== true) {
        annotate({ meta: { reason: "email_unverified" } });
        return failRedirect("oidc_email_unverified");
      }

      const byEmail = await prisma.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
      });

      if (byEmail) {
        // (2) Link ONCE. An account already pinned to a different IdP
        // identity is never silently re-bound — a rebind would let a
        // second IdP identity that acquires the same email capture the
        // account. Audited so the operator can see the collision.
        if (byEmail.oidcIssuer !== null || byEmail.oidcSub !== null) {
          await auditLog("auth.oidc.link_conflict", {
            userId: byEmail.id,
            ipAddress: ip,
          });
          annotate({ meta: { reason: "identity_conflict" } });
          return failRedirect("oidc_identity_conflict");
        }
        // (2b) Never link on the email alone. The local address was never
        // verified — anyone can register with it or type it into a profile —
        // so matching it proves nothing about who owns the account. Record
        // the link this login would make and send the browser to sign in to
        // the account with its own credential; the link is made there
        // (`completePendingOidcLink`), and only for this account.
        await auditLog("auth.oidc.link_pending", {
          userId: byEmail.id,
          ipAddress: ip,
        });
        annotate({ meta: { reason: "link_confirmation_required" } });
        if (isNative) {
          // The native sign-in sheet cannot run the confirmation; the person
          // signs in on the web once, after which the app's SSO works.
          return failRedirect("oidc_link_required");
        }
        const response = errorRedirect("oidc_link_required");
        setPendingLinkCookie(response, {
          userId: byEmail.id,
          issuer: metadata.issuer,
          sub: identity.sub,
        });
        return response;
      } else {
        // (3) Provision.
        const userCount = await prisma.user.count();
        let registrationEnabled = true;
        try {
          const settings = await prisma.appSettings.findUnique({
            where: { id: "singleton" },
          });
          if (settings && !settings.registrationEnabled && userCount > 0) {
            registrationEnabled = false;
          }
        } catch {
          // Table may not exist yet; allow provisioning (matches register/route.ts).
        }
        if (!registrationEnabled) {
          annotate({ meta: { reason: "registration_disabled" } });
          return failRedirect("oidc_registration_disabled");
        }

        const username = await deriveUniqueUsername(email, (candidate) =>
          prisma.user
            .findUnique({ where: { username: candidate } })
            .then((u: unknown) => u !== null),
        );

        // Same server-default resolution the register route uses — an
        // SSO-provisioned account has no registration form to carry the
        // browser-detected timezone.
        const timezone = await resolveServerDefaultTimezone();

        // v1.28.48 — the first provisioned user becomes ADMIN. Deriving that
        // role from the early `userCount` (read above, before username
        // derivation) and then creating without coordination is the same
        // check-then-act race the password-register route closed in v1.28.42:
        // two concurrent OIDC first-logins racing the empty-DB window would
        // both observe `0` and both be minted ADMIN. Serialise the
        // count+insert behind a transaction-scoped advisory lock (released on
        // commit/rollback) and re-count *inside* the lock so the second
        // provision observes the first's committed row and is minted USER.
        // The lock key STRING matches the register route's — an OIDC
        // first-login racing a password first-registration is serialised
        // against the same lock, so only one ADMIN can ever be minted.
        user = await prisma.$transaction(async (tx) => {
          // `pg_advisory_xact_lock` returns void, which the client cannot
          // deserialize as a column — selecting FROM it yields a plain int row.
          await tx.$queryRaw`
            SELECT 1 AS locked
            FROM pg_advisory_xact_lock(hashtextextended('register:first-admin', 0))
          `;
          const priorUsers = await tx.user.count();
          const role = priorUsers === 0 ? "ADMIN" : "USER";
          return tx.user.create({
            data: {
              email: email.toLowerCase(),
              username,
              passwordHash: null,
              role,
              timezone,
              oidcIssuer: metadata.issuer,
              oidcSub: identity.sub,
            },
          });
        });

        await auditLog("auth.oidc.provisioned", {
          userId: user.id,
          ipAddress: ip,
        });
      }
    }

    // Native second factor. OIDC is a DELEGATED factor: it proves the IdP
    // authenticated someone, but it never substitutes for this app's own
    // second factor. An account with a confirmed TOTP secret or a
    // registered security key gets the same MFA challenge step password
    // login gets — no session is minted here; the single-use ticket rides
    // the handoff cookie to the login page (web) or the custom scheme
    // (native), which render the same challenge UI and complete at
    // `/api/auth/mfa/verify`. (The trusted-device skip cannot apply on this
    // path: its cookie is SameSite=Strict, which the browser withholds on an
    // IdP-initiated redirect chain.)
    const hasTotp = Boolean(user.totpConfirmedAt);
    const webauthnKeyCount = await prisma.webauthnMfaCredential.count({
      where: { userId: user.id },
    });
    const hasWebauthn = webauthnKeyCount > 0;

    if (hasTotp || hasWebauthn) {
      const challenge = await createMfaChallenge(user.id, "login");
      const methods: ("totp" | "recovery" | "webauthn")[] = [];
      if (hasTotp) methods.push("totp", "recovery");
      if (hasWebauthn) methods.push("webauthn");
      await auditLog("auth.mfa.challenge", {
        userId: user.id,
        ipAddress: ip,
        details: { source: isNative ? "login.oidc.native" : "login.oidc" },
      });
      annotate({
        action: { name: "auth.mfa.challenge" },
        meta: { mfa_required: true },
      });

      // Native: hand the app the SAME single-use ticket via the custom scheme.
      // No `OIDC_MFA_COOKIE` (it exists only to ferry the ticket to the web
      // login page's script) and no session — the app completes at the
      // existing native-capable `/api/auth/mfa/verify{,/webauthn}` endpoints,
      // which end in `finishLogin` and return the native bundle directly. The
      // ticket alone is inert: single-use, hashed at rest, 5-minute TTL,
      // 5-attempt cap, factor-gated.
      if (isNative) {
        const response = NextResponse.redirect(
          buildNativeCallbackUrl({
            mfa_ticket: challenge.ticket,
            methods: methods.join(","),
          }),
        );
        deleteStateCookie(response);
        return response;
      }

      const loginUrl = oidcAppUrl(LOGIN_ERROR_URL);
      if (stored.next !== "/") {
        loginUrl.searchParams.set("next", stored.next);
      }
      const response = NextResponse.redirect(loginUrl);
      deleteStateCookie(response);
      response.cookies.set(
        OIDC_MFA_COOKIE,
        JSON.stringify({ ticket: challenge.ticket, methods }),
        {
          // Not httpOnly by design — see the constant's doc comment.
          httpOnly: false,
          secure: shouldEmitSecureCookie(),
          sameSite: "lax",
          maxAge: Math.floor(OIDC_MFA_TTL_MS / 1000),
          path: OIDC_MFA_COOKIE_PATH,
        },
      );
      return response;
    }

    const ua = req.headers.get("user-agent");

    // Native, no MFA: mint a one-time handoff code and hand it to the app via
    // the custom scheme. NO session and NO cookie are minted here — the app
    // exchanges the code at `POST /api/auth/oidc/native/token` for the native
    // bundle. `userId` is the resolved identity; the app's S256 challenge
    // (bound at login, tamper-authenticated in the state blob) locks the code
    // to the app instance that started the flow. The session/device are
    // recorded at the exchange via `finishLogin`, not here.
    if (isNative) {
      const { code: handoffCode } = await mintNativeHandoff({
        userId: user.id,
        // Guaranteed present by `isStoredOidcState` when `native === true`.
        appCodeChallenge: stored.appCodeChallenge as string,
        ipAddress: ip,
        userAgent: ua,
      });
      await auditLog("auth.oidc.native.handoff_minted", {
        userId: user.id,
        ipAddress: ip,
      });
      annotate({ action: { name: "auth.oidc.native.handoff_minted" } });
      const response = NextResponse.redirect(
        buildNativeCallbackUrl({ code: handoffCode }),
      );
      deleteStateCookie(response);
      return response;
    }

    // v1.23 parity with password login — the admin-enforced-MFA hint cookie
    // sends a single-factor account into forced enrollment after sign-in.
    await syncMfaEnrollCookie(user.id, {
      totpConfirmedAt: user.totpConfirmedAt,
      mfaEnforced: user.mfaEnforced,
    });

    // The 5th argument stays null: OIDC is a delegated factor, so an SSO
    // session must never satisfy `requireFreshMfa` step-up (MFA disable,
    // encryption-key rotation, encrypted export, account deletion) — the
    // same treatment a trusted-device login gets.
    await createSession(
      user.id,
      user.onboardingCompletedAt === null,
      ip,
      ua,
      null,
    );

    void recordSignInDevice({ userId: user.id, ip, userAgent: ua });

    await auditLog("auth.oidc.login", { userId: user.id, ipAddress: ip });

    const response = NextResponse.redirect(oidcAppUrl(stored.next));
    deleteStateCookie(response);
    return response;
  } catch (err) {
    getEvent()?.setError(err);
    annotate({ meta: { reason: "exchange_or_verify_failed" } });
    return failRedirect("oidc_failed");
  }
});
