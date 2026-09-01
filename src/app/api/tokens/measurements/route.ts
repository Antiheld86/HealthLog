/**
 * `POST /api/tokens/measurements` — mint a Bearer for third-party measurement
 * ingest.
 *
 * The self-service mint that v1.30.17 left missing. That release made the
 * Bearer-scope default fail-closed, which was right — a medication-intake token
 * had been reaching every authenticated route, the full backup export included
 * — and removed the generic mint at the parent path, which was also right,
 * since the token it issued could not do its advertised job. What went with them
 * was any way at all to push readings in programmatically: the OAuth
 * integrations cover Withings and WHOOP, and cover nothing for a local sensor
 * behind a home-automation bridge.
 *
 * What this mints is narrow by construction. `permissions` is a literal, so no
 * request shape reaches it; the scope it names is accepted by exactly two
 * routes, both writes, both on the holder's own record. It cannot read a
 * reading back, cannot edit or delete one, cannot reach the export, and cannot
 * mint another token — no Bearer credential reaches this endpoint at all, at
 * any scope. That last property is why the mint is worth its own file: the
 * blast radius of a credential pasted into a container the user does not
 * operate should not include making more credentials.
 *
 * No listing leg. `/api/tokens` already returns every token with its
 * `permissions`, so the settings card filters that one query rather than
 * duplicating it — the MCP module needs its own list only because it must hide
 * transient OAuth access rows, and there is no such row here. No revoke-all
 * either: `DELETE /api/tokens/[id]` is per-row and the card shows the rows. The
 * per-medication toggle's bulk revoke exists because that surface is a boolean
 * with no list behind it, which is not this surface.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { issueApiToken } from "@/lib/auth/issue-token";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { checkRateLimit } from "@/lib/rate-limit";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";
import { createMeasurementTokenSchema } from "@/lib/validations/tokens";

/**
 * Days a token lives when the caller names no lifetime.
 *
 * Longer than the MCP mint's 90, and the difference is the deployment rather
 * than the risk appetite. A connector token is used from a session somebody is
 * sitting in front of; this one is pasted into a rule that runs unattended for
 * months, where a quiet expiry surfaces as "my weight stopped syncing sometime
 * in the spring". A year is long enough to not be that, short enough to still
 * be a rotation.
 */
const DEFAULT_EXPIRY_DAYS = 365;

/** Mints per user per minute. A credential mint is worth its own bucket. */
const MINT_RATE_LIMIT_MAX = 10;
const MINT_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/**
 * How many ingest tokens an account may hold at once.
 *
 * The rate limit above and this are different guards and neither substitutes
 * for the other. The bucket bounds a burst; it does nothing about
 * accumulation, and a stuck automation retrying politely inside its allowance
 * still reaches several hundred live credentials in an afternoon. This bounds
 * the standing set, so a runaway script meets a refusal rather than leaving a
 * thousand rows for somebody to revoke by hand.
 *
 * Ten is meant to be a number nobody legitimately reaches: a household running
 * Home Assistant, a scale bridge and a couple of scripts sits at three or four.
 * It is not a security boundary — the person can revoke and mint freely — so
 * it is set to catch a loop, not to ration.
 */
const MAX_LIVE_TOKENS = 10;

export const POST = apiHandler(async (request: NextRequest) => {
  // Cookie-only, and the reason is lifetime rather than reach.
  //
  // `requireAuth()` would refuse a narrow token — a measurements credential
  // cannot mint its own successor — but it still admits a cookie-EQUIVALENT
  // one, and that is the case worth closing. A native access token lives a
  // day; what it could mint here lives a year. So a credential that leaked for
  // an afternoon would leave behind one that outlives revoking it, and the
  // revocation would look like it had worked.
  //
  // A session cannot do that: it is held by a browser the person is sitting in
  // front of, and it is the surface this endpoint is reached from anyway. The
  // same argument the passkey-registration and trusted-device routes make, and
  // `requireCookieAuth` is the helper they share.
  const { user } = await requireCookieAuth();
  annotate({ action: { name: "tokens.measurements.create" } });

  if (!(await isApiGloballyEnabled())) {
    return apiError("API is globally disabled", 403);
  }

  const rl = await checkRateLimit(
    `tokens:measurements:mint:${user.id}`,
    MINT_RATE_LIMIT_MAX,
    MINT_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many token mints, try again later", 429);
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = createMeasurementTokenSchema.safeParse(body);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422);
  }

  // Counted LIVE, not minted-ever, so revoking frees a slot and an expired
  // token stops occupying one — the ceiling bounds what currently exists
  // rather than what the account has ever done. Scoped to this grant for the
  // same reason: a login mints a `["*"]` access token per session and those
  // accumulate on their own, so counting every row would let ordinary browser
  // use exhaust the budget and then refuse a mint for a reason invisible to
  // the person hitting it.
  //
  // Placed after validation and before the create: a request that is going to
  // be refused should not cost a credential, and one that is malformed should
  // hear about the malformation rather than the ceiling.
  const live = await prisma.apiToken.count({
    where: {
      userId: user.id,
      revoked: false,
      permissions: { has: MEASUREMENTS_WRITE_SCOPE },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (live >= MAX_LIVE_TOKENS) {
    annotate({
      action: { name: "tokens.measurements.create" },
      meta: { outcome: "ceiling_reached", live_token_count: live },
    });
    // 409 rather than 429: this is a conflict with the account's current
    // state, not a rate, and the remedy is to revoke one rather than to wait.
    // A 429 would tell the caller the opposite of what is true.
    return apiError(
      `You already have ${MAX_LIVE_TOKENS} measurement tokens. Revoke one before creating another.`,
      409,
      { errorCode: "tokens.measurements.ceiling_reached" },
    );
  }

  const issued = await issueApiToken({
    userId: user.id,
    name: parsed.data.name,
    // A literal, never spread and never derived from the body. `issueApiToken`
    // defaults to `["*"]` when this property is absent, so an edit that drops
    // it mints a cookie-equivalent credential from a user-facing endpoint —
    // which is why the unit suite asserts this array and not merely the 201.
    permissions: [MEASUREMENTS_WRITE_SCOPE],
    expiresInDays: parsed.data.expiresInDays ?? DEFAULT_EXPIRY_DAYS,
  });

  await auditLog("tokens.measurements.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { tokenId: issued.tokenId, scope: MEASUREMENTS_WRITE_SCOPE },
  });

  // The raw token, once. It is stored as an HMAC and no path re-reveals it.
  return apiSuccess(
    { token: issued.token, name: issued.name, expiresAt: issued.expiresAt },
    201,
  );
});
