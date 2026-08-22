/**
 * OpenAPI route table — auth surface (login, passkey verify, token refresh).
 *
 * Also the home of `/api/tokens` and `/api/tokens/{id}`: they sit outside the
 * `/api/auth` prefix but a Bearer token is a sign-in credential like a passkey
 * or a session, and splitting the credential lifecycle across two modules is
 * how one half of it stops being maintained.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import {
  loginPasswordSchema,
  passkeyRenameSchema,
} from "@/lib/validations/auth";
import {
  mfaVerifySchema,
  totpConfirmSchema,
  mfaDisableSchema,
  mfaWebauthnRegisterVerifySchema,
  mfaWebauthnRenameSchema,
  mfaWebauthnLoginOptionsSchema,
  mfaWebauthnLoginVerifySchema,
} from "@/lib/validations/mfa";
import { oidcNativeTokenSchema } from "@/lib/validations/oidc-native";
import { nativeHandoffTokenSchema } from "@/lib/validations/native-handoff";
import {
  stepUpMintSchema,
  stepUpOptionsSchema,
} from "@/lib/validations/step-up";
import { dataEnvelope, stdResponses, errorEnvelope } from "./shared";

// ── Sub-schemas owned here (route-specific shapes) ───────────────────

const passkeyLoginVerifyRequest = z
  .object({
    challengeId: z
      .string()
      .min(1)
      .describe("Server-issued WebAuthn challenge id."),
    credential: z
      .object({
        id: z.string(),
        rawId: z.string(),
        type: z.literal("public-key"),
        response: z.record(z.string(), z.unknown()),
        authenticatorAttachment: z
          .enum(["platform", "cross-platform"])
          .optional(),
        clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
      })
      .describe("SimpleWebAuthn-style assertion response payload."),
  })
  .meta({
    id: "PasskeyLoginVerifyRequest",
    description:
      "Passkey assertion verification. Same native-client token issuance as the password path.",
  });

const refreshRequest = z
  .object({
    refreshToken: z
      .string()
      .min(1)
      .describe("Caller-presented refresh token (`hlr_<64hex>`)."),
    revoke: z
      .boolean()
      .optional()
      .describe("When true, revoke the supplied token instead of rotating."),
  })
  .meta({
    id: "RefreshTokenRequest",
    description:
      "Exchange a one-time-use refresh token for a fresh access + refresh pair.",
  });

const accessRefreshBundle = z
  .object({
    user: z.object({ id: z.string(), username: z.string() }),
    token: z
      .string()
      .optional()
      .describe(
        "Access token (`hlk_<64hex>`); only present for native-policy callers. A browser caller gets the session cookie instead.",
      ),
    tokenExpiresAt: z.iso.datetime({ offset: true }).optional(),
    refreshToken: z
      .string()
      .optional()
      .describe(
        "Refresh token (`hlr_<64hex>`); only present for native-policy callers.",
      ),
    refreshTokenExpiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .meta({
    id: "AccessRefreshBundle",
    description:
      "Native-client token bundle returned by login + refresh. Web cookie-only callers see only `user`.",
  });

// ── v1.23 second-factor (MFA) shapes ─────────────────────────────────

const mfaRequiredEnvelope = z
  .object({
    data: z.null(),
    error: z.null(),
    meta: z.object({
      mfaRequired: z.literal(true),
      mfaTicket: z
        .string()
        .describe(
          "Opaque, single-use, ~5-minute ticket to present to /api/auth/mfa/verify.",
        ),
      methods: z
        .array(z.enum(["totp", "recovery", "webauthn"]))
        .describe(
          "Second factors the account can complete the challenge with. `webauthn` is completed via /api/auth/mfa/webauthn/verify; the rest via /api/auth/mfa/verify.",
        ),
    }),
  })
  .meta({
    id: "MfaRequiredResponse",
    description:
      "Password accepted but a second factor is required. Not an error and not a session — no token is issued until /api/auth/mfa/verify succeeds.",
  });

const totpSetupResponse = z
  .object({
    otpauthUri: z
      .string()
      .describe("otpauth:// URI to render as a QR code (carries the secret)."),
    totpSecret: z
      .string()
      .describe("Base32 secret for manual entry. Pending until confirmed."),
  })
  .meta({ id: "TotpSetupResponse" });

const recoveryCodesResponse = z
  .object({
    enabled: z.boolean().optional(),
    recoveryCodes: z
      .array(z.string())
      .describe("Single-use recovery codes, shown once. Save them now."),
    recoveryCodesRemaining: z.number().int(),
  })
  .meta({ id: "MfaRecoveryCodesResponse" });

const mfaToggleResponse = z
  .object({ enabled: z.boolean() })
  .meta({ id: "MfaToggleResponse" });

// ── v1.23 active sessions + security activity shapes ──────────────────

const sessionListResponse = z
  .object({
    sessions: z.array(
      z.object({
        id: z.string(),
        device: z
          .string()
          .describe("Coarse device label derived from the User-Agent."),
        ipMasked: z
          .string()
          .nullable()
          .describe(
            "IP with the host portion masked — never the full address.",
          ),
        location: z
          .string()
          .nullable()
          .describe("Resolved coarse location, when available."),
        lastActiveAt: z.iso.datetime({ offset: true }).nullable(),
        createdAt: z.iso.datetime({ offset: true }),
        isCurrent: z
          .boolean()
          .describe("True for the session making this request."),
      }),
    ),
  })
  .meta({ id: "SessionListResponse" });

const trustedDeviceListResponse = z
  .object({
    devices: z.array(
      z.object({
        id: z.string(),
        label: z
          .string()
          .nullable()
          .describe("Coarse, IP-free device label (e.g. 'Firefox on macOS')."),
        createdAt: z.iso.datetime({ offset: true }),
        lastUsedAt: z.iso.datetime({ offset: true }),
        expiresAt: z.iso.datetime({ offset: true }),
        isCurrent: z
          .boolean()
          .describe("True for the device making this request."),
      }),
    ),
  })
  .meta({ id: "TrustedDeviceListResponse" });

const signOutEverywhereResponse = z
  .object({
    sessionsRevoked: z
      .number()
      .int()
      .describe("Number of OTHER sessions removed (the current one is kept)."),
  })
  .meta({ id: "SignOutEverywhereResponse" });

const securityActivityResponse = z
  .object({
    events: z.array(
      z.object({
        action: z
          .string()
          .describe("Audit action name, e.g. auth.login.password."),
        createdAt: z.iso.datetime({ offset: true }),
        location: z.string().nullable(),
        ipMasked: z.string().nullable().describe("Host-masked IP."),
        carrier: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: "SecurityActivityResponse" });

// ── v1.23 WebAuthn second-factor + status shapes ─────────────────────

const webauthnCredentialInfo = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({ id: "WebauthnMfaCredentialInfo" });

// ── Passkey list (primary sign-in credentials) ───────────────────────
// A DIFFERENT surface from `WebauthnMfaCredentialInfo` above: these are
// the credentials a passkey LOGIN asserts against, not the security keys
// registered as a second factor. The two lists are served by different
// routes and are never merged.

const passkeyInfo = z
  .object({
    id: z.string().describe("Row id; the handle for DELETE."),
    name: z.string().describe("User-supplied label, defaulting to “Passkey”."),
    credentialDeviceType: z
      .string()
      .describe(
        "Authenticator device type as reported at registration: `singleDevice` for a credential bound to one authenticator, `multiDevice` for a syncable one.",
      ),
    credentialBackedUp: z
      .boolean()
      .describe(
        "Whether the authenticator reported the credential as backed up (synced to the platform keychain) at registration time. Not re-read afterwards.",
      ),
    createdAt: z.iso.datetime({ offset: true }).describe("Registered at."),
    lastUsedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "When this passkey last completed a verified assertion; null when it has never been used to sign in. Stamped on every successful login, so a client can render a real 'last used' rather than assuming never.",
      ),
  })
  .meta({ id: "PasskeyInfo" });

const passkeyListResponse = z
  .array(passkeyInfo)
  .meta({ id: "PasskeyListResponse" });

const mfaStatusResponse = z
  .object({
    totp: z.object({ enabled: z.boolean() }),
    recoveryCodesRemaining: z.number().int(),
    webauthn: z.array(webauthnCredentialInfo),
    passkeyNudgeDismissed: z.boolean(),
  })
  .meta({ id: "MfaStatusResponse" });

const webauthnOptionsResponse = z
  .object({
    options: z
      .record(z.string(), z.unknown())
      .describe("SimpleWebAuthn options to pass to the browser ceremony."),
    challengeId: z.string().describe("Server-issued challenge id."),
  })
  .meta({ id: "WebauthnOptionsResponse" });

const successFlagResponse = z
  .object({ success: z.boolean() })
  .meta({ id: "AuthSuccessFlagResponse" });

// ── iOS onboarding discovery (check-user) ────────────────────────────

const checkUserRequest = z
  .object({
    identifier: z
      .string()
      .trim()
      .min(1)
      .max(254)
      .describe(
        "The typed identifier — either an email or a username. Queried verbatim (no case-folding), never echoed back.",
      ),
  })
  .meta({
    id: "CheckUserRequest",
    description:
      "Discovery lookup for the iOS onboarding flow: given a typed email or username, resolve the next sign-in step.",
  });

const checkUserResponse = z
  .object({
    branch: z
      .enum(["not_found", "passkey_only", "email_fallback", "exists"])
      .describe(
        "Next UX step: `not_found` (show sign-up), `passkey_only` (Sign in with Passkey), `email_fallback` (password field, with a Passkey affordance when applicable), `exists` (account with no usable credential — recovery path).",
      ),
    hasPasskey: z
      .boolean()
      .describe("The account has at least one registered passkey."),
    hasPassword: z.boolean().describe("The account has a password hash."),
  })
  .meta({
    id: "CheckUserResponse",
    description:
      "Account-existence + credential shape. The response is identical whether or not the identifier matched (account-existence is the explicit contract iOS needs); the identifier is never echoed.",
  });

/**
 * Shared tail for every route the step-up elevation can unlock. Kept in one
 * place so the published contract cannot describe the set inconsistently.
 */
const MFA_MANAGEMENT_AUTH_NOTE =
  " Accepts a cookie session, or a Bearer token presenting a single-use elevation from POST /api/auth/step-up in the `X-Step-Up` header; a Bearer token alone is still refused.";

// ── v1.30.34 step-up elevation (Bearer transport) ────────────────────

const stepUpOptionsResponse = z
  .object({
    options: z
      .record(z.string(), z.unknown())
      .describe("SimpleWebAuthn assertion options for the caller's passkeys."),
    challengeId: z.string(),
  })
  .meta({ id: "StepUpOptionsResponse" });

const stepUpMintResponse = z
  .object({
    elevation: z
      .string()
      .describe(
        "Opaque single-use elevation (`hle_<64hex>`). Present it in the `X-Step-Up` header on ONE second-factor-management call. Returned exactly once; store it in memory only.",
      ),
    expiresAt: z.iso.datetime({ offset: true }),
    expiresInSeconds: z.number().int(),
    method: z
      .enum(["password", "totp", "webauthn", "passkey"])
      .describe("The factor that was re-proved."),
    satisfiesFreshFactor: z
      .boolean()
      .describe(
        "Whether this elevation reaches the fresh-factor routes (MFA disable, recovery-code regeneration, security-key removal). False for a password proof — mirroring the web, where a password login never marks a session second-factor-verified.",
      ),
  })
  .meta({ id: "StepUpMintResponse" });

// ── Sign-out, pre-session discovery, API tokens ──────────────────────
// Seven operations that shipped without ever entering the registry. The drift
// gate compares the registry against the YAML and never the ROUTES against the
// registry, so a route that was simply never registered stayed invisible to it.

const logoutResponse = z
  .object({
    loggedOut: z
      .literal(true)
      .describe(
        "Always true. The endpoint has no failure the caller acts on: it answers the same whether a cookie was cleared, a token was revoked, or neither was there.",
      ),
  })
  .meta({ id: "LogoutResponse" });

const oidcStatusResponse = z
  .object({
    enabled: z
      .boolean()
      .describe("An OIDC provider is configured on this instance."),
    buttonLabel: z
      .string()
      .nullable()
      .describe(
        "Operator-set label for the SSO button (`OIDC_BUTTON_LABEL`, defaulting to “Single Sign-On”). Null when no provider is configured.",
      ),
    only: z
      .boolean()
      .describe(
        "`OIDC_ONLY=true` — password and passkey login are refused with 403 `oidc_only`. A client that offers those controls anyway strands the user.",
      ),
  })
  .meta({ id: "OidcStatusResponse" });

const registrationStatusResponse = z
  .object({
    registrationEnabled: z
      .boolean()
      .describe(
        "Whether open self-registration is on. An operator who turned it off can still admit a signup through an invite token.",
      ),
  })
  .meta({ id: "RegistrationStatusResponse" });

const apiTokenInfo = z
  .object({
    id: z.string().describe("Row id; the handle for DELETE."),
    name: z.string(),
    permissions: z
      .array(z.string())
      .describe(
        'The token\'s scope list. `["*"]` is cookie-equivalent (what a native login mints); anything else is narrow and reaches only the routes that name it. Admin endpoints are cookie-only and are reachable by no token at any scope.',
      ),
    lastUsedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("Stamped fire-and-forget on use; null for an unused token."),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    revoked: z
      .boolean()
      .describe(
        "Revoked tokens stay in the list rather than disappearing, so a client must filter on this rather than treat presence as validity.",
      ),
  })
  .meta({ id: "ApiTokenInfo" });

const apiTokenListResponse = z
  .array(apiTokenInfo)
  .meta({ id: "ApiTokenListResponse" });

export const authPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/auth/check-user": {
    post: {
      tags: ["Auth"],
      summary: "Resolve the next sign-in step for a typed identifier",
      description:
        "Given an email or username, returns which onboarding branch the iOS client should render plus the `hasPasskey` / `hasPassword` booleans so it can offer a Passkey affordance alongside a password field without a second round-trip. Anonymous surface; per-IP rate-limited (30 requests / 15 min). The response is the same whether or not the identifier matched, and the identifier is never echoed back.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: checkUserRequest } },
      },
      responses: {
        "200": {
          description: "Discovery result.",
          content: {
            "application/json": {
              schema: dataEnvelope(checkUserResponse, "CheckUserEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/login": {
    post: {
      tags: ["Auth"],
      summary: "Email-or-username login (password)",
      description:
        "Browser callers receive a session cookie. Native callers (X-Client-Type: native or HealthLog-iOS UA prefix) additionally receive a paired access + refresh token.\n\n" +
        "v1.23 — when the account has a confirmed second factor, the response carries no session/token. It returns HTTP 200 with `data: null, error: null` and `meta.mfaRequired: true` plus a single-use `meta.mfaTicket` and the `meta.methods` list. The client must POST the ticket + a code to `/api/auth/mfa/verify` to obtain the token bundle. Accounts without MFA are unchanged.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: loginPasswordSchema } },
      },
      responses: {
        "200": {
          description:
            "Login succeeded (token bundle / cookie) — or a second factor is required (`meta.mfaRequired`).",
          content: {
            "application/json": {
              schema: z.union([
                dataEnvelope(accessRefreshBundle, "LoginResponse"),
                mfaRequiredEnvelope,
              ]),
            },
          },
        },
        "403": {
          description:
            "Password login is disabled — the operator runs `OIDC_ONLY=true`. `meta.errorCode` = `oidc_only`; sign in through SSO instead.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/mfa/verify": {
    post: {
      tags: ["Auth"],
      summary: "Complete a second-factor login challenge",
      description:
        "Presents the `mfaTicket` from the login `meta.mfaRequired` response plus a TOTP or recovery code. On success returns the SAME token bundle / session the password path issues, with the session marked second-factor-verified. The ticket is single-use; wrong codes are throttled and the ticket is burned at the attempt cap.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: mfaVerifySchema } },
      },
      responses: {
        "200": {
          description:
            "Second factor verified — session + optional bearer issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(accessRefreshBundle, "MfaVerifyResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/oidc/native/token": {
    post: {
      tags: ["Auth"],
      summary: "Exchange a native OIDC handoff code for the token bundle",
      description:
        "The cookie-less native leg of the OIDC SSO flow. The iOS app opens `GET /api/auth/oidc/login?client=native&code_challenge=<S256>` inside an `ASWebAuthenticationSession`; the callback returns a one-time handoff code on `healthlog://oidc-callback?code=hlh_…` (or an `mfa_ticket` when the account has a second factor, completed at /api/auth/mfa/verify). This endpoint exchanges the code + its PKCE `codeVerifier` for the SAME native bundle password login issues.\n\n" +
        "Requires the native transport (no cookie, non-browser UA) — a browser is rejected. The code is single-use and expires in ~90 seconds; a replay of a consumed code revokes the pair the first exchange issued. A single generic 401 covers every invalid/expired/used/PKCE-mismatch case.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: oidcNativeTokenSchema } },
      },
      responses: {
        "200": {
          description: "Handoff accepted — native access + refresh bundle.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                accessRefreshBundle,
                "OidcNativeTokenResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/native/login": {
    get: {
      tags: ["Auth"],
      summary: "Start the first-party web-handoff login (browser navigation)",
      description:
        "First leg of the native web-handoff login (iOS #65). On a self-hosted domain the iOS app opens this URL inside an `ASWebAuthenticationSession` with its PKCE `code_challenge`, so the login runs in the instance's real web origin (fixing password autofill + passkeys). The endpoint validates the challenge, sets a short-lived encrypted state cookie carrying the challenge + a DB-clock start time, and 302-redirects to `/auth/login?flow=native`. It writes no database rows. Every error 302-redirects to `healthlog://login-callback?error=<reason>` (a closed set: `invalid_request`, `rate_limited`) — an error carries no code or session. Anonymous; rate-limited 10 / 15 min.",
      requestParams: {
        query: z.object({
          code_challenge: z
            .string()
            .min(43)
            .max(128)
            .describe(
              "The app's PKCE S256 challenge (RFC 7636). `plain` is unsupported.",
            ),
        }),
      },
      responses: {
        "302": {
          description:
            "Redirect to `/auth/login?flow=native` (state cookie set) on success, or to `healthlog://login-callback?error=<reason>` on failure.",
        },
      },
    },
  },
  "/api/auth/native/complete": {
    get: {
      tags: ["Auth"],
      summary:
        "Complete the web-handoff login and mint the code (browser navigation)",
      description:
        "Second leg of the native web-handoff login (iOS #65). After an interactive login on `/auth/login?flow=native`, the page navigates the browser here as a top-level GET. The endpoint validates the web session against the database, enforces the freshness binding (`session.createdAt >= startedAt`, both DB-clock — a pre-existing session is refused), mints a single-use PKCE-locked handoff code, deletes the state cookie, destroys the scaffold web session, and 302-redirects to `healthlog://login-callback?code=hlh_…`. The token pair never rides the URL; only the opaque code does. The app never calls this directly. Every failure 302-redirects to `healthlog://login-callback?error=<reason>` (`invalid_state`, `no_session`, `stale_session`, `rate_limited`). Rate-limited 20 / 15 min.",
      responses: {
        "302": {
          description:
            "Redirect to `healthlog://login-callback?code=hlh_…` on success, or `…?error=<reason>` on any failure.",
        },
      },
    },
  },
  "/api/auth/native/token": {
    post: {
      tags: ["Auth"],
      summary: "Exchange a web-handoff code for the token bundle",
      description:
        "Third leg of the native web-handoff login (iOS #65). The app exchanges the one-time handoff code from `healthlog://login-callback?code=hlh_…` plus its PKCE `codeVerifier` for the SAME native bundle password login issues.\n\n" +
        "Requires the native transport (no cookie, non-browser UA) — a browser is rejected. The code is single-use and expires in ~90 seconds; a replay of a consumed code revokes the pair the first exchange issued. The exchange is flow-gated: a code minted by the OIDC native leg is not redeemable here (and vice versa). A single generic 401 covers every invalid / expired / used / PKCE-mismatch / cross-flow case.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: nativeHandoffTokenSchema } },
      },
      responses: {
        "200": {
          description: "Handoff accepted — native access + refresh bundle.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                accessRefreshBundle,
                "NativeHandoffTokenResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/step-up/options": {
    post: {
      tags: ["Auth"],
      summary:
        "Begin a WebAuthn re-proof for a step-up elevation (Bearer only)",
      description:
        'Returns SimpleWebAuthn assertion options plus a challenge id to present at POST /api/auth/step-up. `method: "passkey"` scopes the assertion to the account\'s primary passkeys; `method: "webauthn"` to its registered second-factor security keys. Bearer-only: a cookie session is refused, because a browser re-proves its factor at login and carries the result on its session row. Returns 409 when the account has no credential of the requested kind — fall back to another arm of the mint.',
      requestBody: {
        required: true,
        content: { "application/json": { schema: stepUpOptionsSchema } },
      },
      responses: {
        "200": {
          description: "Assertion options issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                stepUpOptionsResponse,
                "StepUpOptionsEnvelope",
              ),
            },
          },
        },
        "409": {
          description: "No passkey registered on this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/step-up": {
    post: {
      tags: ["Auth"],
      summary: "Mint a single-use step-up elevation (Bearer only)",
      description:
        "Re-prove a factor and receive an opaque elevation that authorises exactly ONE second-factor-management call.\n\n" +
        "WHICH factor you re-prove decides WHAT the elevation reaches. `password` reaches the same routes a plain cookie session reaches. `totp`, `webauthn`, and `passkey` additionally satisfy the fresh-factor routes — MFA disable, recovery-code regeneration, security-key removal — which is precisely the set of ceremonies for which the web marks a session second-factor-verified. The response carries `satisfiesFreshFactor` so a client can choose the right ceremony up front rather than discovering the refusal after spending a proof. A recovery code is NOT accepted here; an account that has lost its authenticator manages its second factor on the web.\n\n" +
        "The elevation is bound to the exact token that minted it (another token, including the same account's, cannot redeem it), single-use, and valid for five minutes — the same window the cookie path uses. Present it as `X-Step-Up: hle_…` alongside the normal `Authorization: Bearer` header. It is spent only when the target route is about to act, so a 429, a 422, or a wrong code does not burn it.\n\n" +
        "Presenting the token alone mints nothing: the body must carry a fresh factor proof. Every failure — wrong password, no password set on an SSO-provisioned account, an assertion for another account, a stale challenge, a replayed TOTP step — returns the same 401 with the same prose, and is audited server-side. Rate-limited per account (5 / 15 min) and per source address.\n\n" +
        "Accepting routes (the complete set): POST /api/auth/me/mfa/totp/setup; POST /api/auth/me/mfa/totp/confirm; POST /api/auth/me/mfa/disable; POST /api/auth/me/mfa/recovery-codes/regenerate; POST /api/auth/me/mfa/webauthn/register/options; POST /api/auth/me/mfa/webauthn/register/verify; PATCH and DELETE /api/auth/me/mfa/webauthn/{id}. The last three of those and disable require a fresh-factor proof. GET /api/auth/me/mfa needs no elevation at all. Nothing else accepts one — admin endpoints stay cookie-only.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: stepUpMintSchema } },
      },
      responses: {
        "200": {
          description: "Factor re-proved — elevation issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(stepUpMintResponse, "StepUpMintEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa/totp/setup": {
    post: {
      tags: ["Auth"],
      summary: "Begin TOTP enrollment (cookie session or step-up elevation)",
      description:
        "Generates and stores a pending (encrypted) TOTP secret and returns the otpauth URI + Base32 secret. MFA is not active until /confirm." +
        MFA_MANAGEMENT_AUTH_NOTE,
      responses: {
        "200": {
          description: "Pending secret created.",
          content: {
            "application/json": {
              schema: dataEnvelope(totpSetupResponse, "TotpSetupEnvelope"),
            },
          },
        },
        "409": {
          description: "A second factor is already active on this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa/totp/confirm": {
    post: {
      tags: ["Auth"],
      summary: "Confirm TOTP enrollment (cookie session or step-up elevation)",
      description:
        "Verifies a code against the pending secret, activates the factor, and returns the one-time recovery codes." +
        MFA_MANAGEMENT_AUTH_NOTE,
      requestBody: {
        required: true,
        content: { "application/json": { schema: totpConfirmSchema } },
      },
      responses: {
        "200": {
          description: "Factor activated — recovery codes returned once.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                recoveryCodesResponse,
                "TotpConfirmEnvelope",
              ),
            },
          },
        },
        "409": {
          description:
            "A second factor is already active, or enrollment was never started (no pending secret to confirm).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa/disable": {
    post: {
      tags: ["Auth"],
      summary: "Disable the second factor (step-up gated)",
      description:
        "Requires a fresh second-factor step-up AND a current TOTP or recovery code. Clears the secret and deletes recovery codes." +
        MFA_MANAGEMENT_AUTH_NOTE,
      requestBody: {
        required: true,
        content: { "application/json": { schema: mfaDisableSchema } },
      },
      responses: {
        "200": {
          description: "Factor disabled.",
          content: {
            "application/json": {
              schema: dataEnvelope(mfaToggleResponse, "MfaDisableEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa/recovery-codes/regenerate": {
    post: {
      tags: ["Auth"],
      summary: "Regenerate recovery codes (step-up gated)",
      description:
        "Invalidates the entire prior recovery-code set and returns a fresh batch once. Step-up gated." +
        MFA_MANAGEMENT_AUTH_NOTE,
      responses: {
        "200": {
          description: "Fresh recovery codes issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                recoveryCodesResponse,
                "MfaRecoveryRegenEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa": {
    get: {
      tags: ["Auth"],
      summary: "Second-factor status (cookie session or Bearer token)",
      description:
        "Whether TOTP is active, how many recovery codes remain, and the registered WebAuthn security keys. Metadata only — no secret, no code, no public key, no credential id. Plain authentication (cookie session or cookie-equivalent token); unlike every mutation on this surface it needs no step-up elevation, because the payload carries no credential material.",
      responses: {
        "200": {
          description: "Second-factor status.",
          content: {
            "application/json": {
              schema: dataEnvelope(mfaStatusResponse, "MfaStatusEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa/webauthn/register/options": {
    post: {
      tags: ["Auth"],
      summary: "Begin registering a security key as a second factor",
      description:
        "Returns SimpleWebAuthn creation options + a challenge id." +
        MFA_MANAGEMENT_AUTH_NOTE,
      responses: {
        "200": {
          description: "Registration options issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                webauthnOptionsResponse,
                "MfaWebauthnRegisterOptionsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa/webauthn/register/verify": {
    post: {
      tags: ["Auth"],
      summary: "Finish registering a security key as a second factor",
      description:
        "Verifies the attestation against the user-bound challenge and stores the credential in the second-factor store (separate from primary passkeys)." +
        MFA_MANAGEMENT_AUTH_NOTE,
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: mfaWebauthnRegisterVerifySchema },
        },
      },
      responses: {
        "200": {
          description: "Security key registered.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                webauthnCredentialInfo,
                "MfaWebauthnRegisterVerifyEnvelope",
              ),
            },
          },
        },
        "400": {
          description: "Security key verification failed (bad attestation).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/mfa/webauthn/{id}": {
    patch: {
      tags: ["Auth"],
      summary: "Rename a registered security key",
      description:
        "Rename a registered second-factor security key." +
        MFA_MANAGEMENT_AUTH_NOTE,
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: mfaWebauthnRenameSchema } },
      },
      responses: {
        "200": {
          description: "Security key renamed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                webauthnCredentialInfo,
                "MfaWebauthnRenameEnvelope",
              ),
            },
          },
        },
        "404": {
          description: "No such security key for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Auth"],
      summary: "Remove a registered security key (step-up gated)",
      description:
        "Requires a fresh second-factor step-up." + MFA_MANAGEMENT_AUTH_NOTE,
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Security key removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                successFlagResponse,
                "MfaWebauthnRemoveEnvelope",
              ),
            },
          },
        },
        "404": {
          description: "No such security key for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/mfa/webauthn/verify/options": {
    post: {
      tags: ["Auth"],
      summary: "Begin a mid-login security-key assertion",
      description:
        "Presents the login `mfaTicket` and returns assertion options scoped to the password-identified user's registered security keys. Anonymous surface; rate-limited.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: mfaWebauthnLoginOptionsSchema },
        },
      },
      responses: {
        "200": {
          description: "Assertion options issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                webauthnOptionsResponse,
                "MfaWebauthnLoginOptionsEnvelope",
              ),
            },
          },
        },
        "409": {
          description:
            "No security key is registered on the account — fall back to the TOTP / recovery-code challenge.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/mfa/webauthn/verify": {
    post: {
      tags: ["Auth"],
      summary: "Complete a security-key second-factor login challenge",
      description:
        "Presents the login `mfaTicket` plus the assertion. On success returns the SAME token bundle / session the password path issues, with the session marked second-factor-verified. The ticket is single-use; failures are throttled and the ticket is burned at the attempt cap.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: mfaWebauthnLoginVerifySchema },
        },
      },
      responses: {
        "200": {
          description:
            "Second factor verified — session + optional bearer issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                accessRefreshBundle,
                "MfaWebauthnVerifyResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/passkey/login-verify": {
    post: {
      tags: ["Auth"],
      summary: "Passkey assertion verification",
      requestBody: {
        required: true,
        content: { "application/json": { schema: passkeyLoginVerifyRequest } },
      },
      responses: {
        "200": {
          description: "Assertion verified — session + optional bearer issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                accessRefreshBundle,
                "PasskeyLoginVerifyResponse",
              ),
            },
          },
        },
        "403": {
          description:
            "Passkey login is disabled — the operator runs `OIDC_ONLY=true`. `meta.errorCode` = `oidc_only`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description:
            "The assertion resolved to a user row that no longer exists.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/refresh": {
    post: {
      tags: ["Auth"],
      summary: "Rotate refresh token (one-time use)",
      description:
        "Reuse of a consumed refresh token revokes every refresh token still active for the originating device (per-device blast radius from v1.4.23). Legacy tokens issued before v1.4.23 with a null deviceId fall back to revoke-all-for-user.\n\n" +
        "On a 401, `meta.errorCode` is a stable machine code so the client can branch terminal re-auth from a transient blip without parsing the prose `error`: `auth.refresh.reuse` (a consumed token was replayed — device family revoked, re-pair required), `auth.refresh.revoked` (family revoked out-of-band — re-pair required), `auth.refresh.invalid` (not found / expired — drop the token and re-authenticate).",
      requestBody: {
        required: true,
        content: { "application/json": { schema: refreshRequest } },
      },
      responses: {
        "200": {
          description:
            "Rotation succeeded — new pair issued. When the request carried `revoke: true` the body is `{ revoked }` instead: the token family is invalidated and no new pair is minted.",
          content: {
            "application/json": {
              schema: z.union([
                dataEnvelope(accessRefreshBundle, "RefreshResponse"),
                dataEnvelope(
                  z.object({ revoked: z.boolean() }),
                  "RefreshRevokeResponse",
                ),
              ]),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/passkeys": {
    get: {
      tags: ["Auth"],
      summary: "List the caller's registered passkeys",
      description:
        "The passkeys registered for primary sign-in, newest first. Distinct from the second-factor security keys in `GET /api/auth/2fa/status` (`webauthn`) — a passkey replaces the password, a security key is asserted after one. `lastUsedAt` is stamped on every verified assertion and is null only for a passkey that has never signed in.",
      responses: {
        "200": {
          description: "The caller's passkeys, newest first.",
          content: {
            "application/json": {
              schema: dataEnvelope(passkeyListResponse, "PasskeyListEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/sessions": {
    get: {
      tags: ["Auth"],
      summary: "List active web sessions",
      description:
        "v1.23 — the user-facing active-session list (issue #64). One row per browser login with a coarse device label, masked IP, resolved location, sliding last-active time, and the current-session marker. Distinct from /api/auth/me/devices (notification devices).",
      responses: {
        "200": {
          description: "Active sessions for the caller.",
          content: {
            "application/json": {
              schema: dataEnvelope(sessionListResponse, "SessionListEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Auth"],
      summary: "Sign out everywhere else",
      description:
        "v1.23 — revokes every OTHER web session plus all native refresh tokens, keeping the caller's current session. API tokens are not touched (manage those under /settings/api-tokens).",
      responses: {
        "200": {
          description: "Other sessions revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                signOutEverywhereResponse,
                "SignOutEverywhereEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/sessions/{id}": {
    delete: {
      tags: ["Auth"],
      summary: "Revoke a single web session",
      description:
        "v1.23 — revokes one session by id, scoped to the authenticated user (a foreign id returns 404, never another user's row).",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Session revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ revoked: z.boolean() }),
                "SessionRevokeEnvelope",
              ),
            },
          },
        },
        "404": {
          description: "Session not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/trusted-devices": {
    get: {
      tags: ["Auth"],
      summary: "List trusted devices",
      description:
        "v1.23 — the 'remember this device' list. A trusted device skips the second factor for 30 days (the password is still required). Returns only an IP-free device label + lifecycle timestamps, never the token.",
      responses: {
        "200": {
          description: "Trusted devices for the caller.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                trustedDeviceListResponse,
                "TrustedDeviceListEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Auth"],
      summary: "Forget every trusted device",
      description:
        "v1.23 — revokes all trusted devices for the caller and clears the caller's own trusted-device cookie.",
      responses: {
        "200": {
          description: "All trusted devices revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ revoked: z.number().int() }),
                "TrustedDeviceRevokeAllEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/trusted-devices/{id}": {
    delete: {
      tags: ["Auth"],
      summary: "Revoke a single trusted device",
      description:
        "v1.23 — revokes one trusted device by id, scoped to the authenticated user (a foreign id returns 404).",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Trusted device revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ revoked: z.boolean() }),
                "TrustedDeviceRevokeEnvelope",
              ),
            },
          },
        },
        "404": {
          description: "Trusted device not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/auth/me/security-activity": {
    get: {
      tags: ["Auth"],
      summary: "List recent account-security activity",
      description:
        "v1.23 — the SHARED security-activity feed: the caller's recent auth + export + deletion audit events with timestamp, resolved location, and a host-masked IP. `limit` query param caps at 100 (default 50). Reuses the AuditLog store; no event detail bodies are surfaced.",
      requestParams: {
        query: z.object({
          limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe("Page size; defaults to 50, clamped to 100."),
        }),
      },
      responses: {
        "200": {
          description: "Recent security events for the caller.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                securityActivityResponse,
                "SecurityActivityEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  // ── Appended: routes the iOS client calls that the registry never carried.
  "/api/auth/logout": {
    post: {
      tags: ["Auth"],
      summary: "End the calling session, and the calling token with it",
      description:
        "Clears the browser session cookie. When the request ALSO carries `Authorization: Bearer hlk_…` it revokes that access token and the refresh sibling paired with it, so a native client signs out in one call rather than through the refresh endpoint's `revoke: true` arm.\n\n" +
        "Takes no body and needs no credential: an unauthenticated call answers 200 exactly like an authenticated one. Whether the Bearer revocation actually found a row is recorded server-side and is deliberately absent from the response — a caller that could read it would learn whether a token it presented was live.",
      responses: {
        "200": {
          description:
            "Sign-out performed as far as the presented credentials allowed.",
          content: {
            "application/json": {
              schema: dataEnvelope(logoutResponse, "LogoutEnvelope"),
            },
          },
        },
      },
    },
  },
  "/api/auth/oidc/status": {
    get: {
      tags: ["Auth"],
      summary: "Whether SSO is configured, and whether it is the only way in",
      description:
        "Public and pre-session: the login surface reads it to decide whether to render the SSO button and whether to hide the password / passkey controls. Pure environment reads, no database, so it has no failure mode — it answers 200 on every call.",
      responses: {
        "200": {
          description: "The SSO posture of this instance.",
          content: {
            "application/json": {
              schema: dataEnvelope(oidcStatusResponse, "OidcStatusEnvelope"),
            },
          },
        },
      },
    },
  },
  "/api/auth/registration-status": {
    get: {
      tags: ["Auth"],
      summary: "Whether self-registration is open",
      description:
        "Public and pre-session: the sign-up surface reads it before offering a registration form. Fails CLOSED — when the settings read throws, the response is a well-formed 200 carrying `registrationEnabled: false` rather than an error, so a client cannot tell a genuinely closed instance from a database blip and must treat both as closed.",
      responses: {
        "200": {
          description:
            "Registration posture. Also the shape returned when the settings read failed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                registrationStatusResponse,
                "RegistrationStatusEnvelope",
              ),
            },
          },
        },
      },
    },
  },
  "/api/auth/passkey/login-options": {
    post: {
      tags: ["Auth"],
      summary: "Begin a passkey sign-in (discoverable credentials)",
      description:
        "Returns SimpleWebAuthn assertion options plus a server-issued challenge id to present at POST /api/auth/passkey/login-verify. Anonymous, takes no body, and scopes the assertion to no account — the options carry no `allowCredentials`, so the authenticator picks the credential and the endpoint is not an account-existence oracle. Rate-limited 10 / 15 min through the anonymous auth-surface bucket, which collapses every caller into one bucket if the proxy trust chain is misconfigured rather than falling open.",
      responses: {
        "200": {
          description: "Assertion options issued.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                webauthnOptionsResponse,
                "PasskeyLoginOptionsEnvelope",
              ),
            },
          },
        },
        "403": {
          description:
            "Passkey login is disabled — the operator runs `OIDC_ONLY=true`. `meta.errorCode` = `oidc_only`. Checked BEFORE the rate limit, so an instance in this mode answers 403 rather than 429 however hard it is polled.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": stdResponses["429"],
      },
    },
  },
  "/api/auth/passkeys/{id}": {
    patch: {
      tags: ["Auth"],
      summary: "Rename a registered passkey",
      description:
        "Relabels one primary sign-in credential, scoped to the authenticated user. Returns the full passkey row, so the client can replace its list entry rather than re-read.\n\n" +
        "The name is trimmed before validation and must be 1 to 64 characters once trimmed. A rejected name earns the standard multi-issue 422, so a form can put the reason beside the field rather than showing a bare “invalid request”.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: passkeyRenameSchema } },
      },
      responses: {
        "200": {
          description: "Passkey renamed.",
          content: {
            "application/json": {
              schema: dataEnvelope(passkeyInfo, "PasskeyRenameEnvelope"),
            },
          },
        },
        "404": {
          description: "No such passkey for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Auth"],
      summary: "Remove a registered passkey",
      description:
        "Deletes one primary sign-in credential, scoped to the authenticated user. Refuses to remove the LAST one when the account has no password — an account must keep at least one way in.\n\n" +
        "No step-up: this endpoint takes a plain cookie session or a wildcard Bearer token, where removing a second-factor security key (DELETE /api/auth/me/mfa/webauthn/{id}) requires a fresh factor proof. The asymmetry is in the code as it stands, not a description of intent.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Passkey removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                successFlagResponse,
                "PasskeyRemoveEnvelope",
              ),
            },
          },
        },
        "400": {
          description:
            "This is the account's only passkey and it has no password — at least one authentication method must remain. Set a password, or register a second passkey, before retrying.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description: "No such passkey for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/tokens": {
    get: {
      tags: ["Auth"],
      summary: "List the caller's API tokens",
      description:
        "Every `ApiToken` row belonging to the caller, newest first, revoked ones included — presence in this list is not validity, `revoked` is. The hash is never returned and there is no path that re-reveals a token's plaintext.\n\n" +
        "Three things the name understates. The list is not limited to tokens a person minted from the settings surface: a native login mints a wildcard access token as an `ApiToken` row, so a signed-in phone shows up here too. There is no mint on this path any more — the generic POST that issued `[\"medication:ingest\"]` was removed, because that scope reached no ingest route while the pre-fail-closed default let it reach everything else; the working credential comes from the per-medication API-endpoint toggle. And unlike the revoke, this read is NOT gated on the operator's instance-wide API switch: that switch governs the surfaces a token is for, not a token's ability to authenticate, so tokens stay live while it is off and their owner has to be able to see them.",
      responses: {
        "200": {
          description: "The caller's tokens, newest first.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                apiTokenListResponse,
                "ApiTokenListEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/tokens/{id}": {
    delete: {
      tags: ["Auth"],
      summary: "Revoke an API token",
      description:
        "Marks one token revoked, scoped to the authenticated user (a foreign id returns 404, never another user's row). The row is kept rather than deleted so it stays visible in the list with `revoked: true`.\n\n" +
        "Nothing exempts the caller's own credential: a Bearer client that revokes the token it is presenting completes the call and is unauthenticated from the next one onwards.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Token revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ revoked: z.boolean() }),
                "ApiTokenRevokeEnvelope",
              ),
            },
          },
        },
        "403": {
          description:
            "The operator has switched the API off instance-wide (`AppSettings.apiGlobal`). No `meta.errorCode`; nothing was revoked. The sibling list is deliberately not gated this way — a token stays live while the switch is off, so its owner can still see it here even though this call will not kill it.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description: "Token not found or not owned by the caller.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
