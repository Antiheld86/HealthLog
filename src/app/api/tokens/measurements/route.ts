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
 * mint another token — the `requireAuth()` below names no scope, so a
 * measurements token presenting itself here is refused like any other narrow
 * credential. That last property is why the mint is worth its own file: the
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

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
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

export const POST = apiHandler(async (request: NextRequest) => {
  // No scope argument, and that is load-bearing rather than incidental: it
  // keeps the fail-closed default, so the only credentials that reach the mint
  // are a cookie session and a cookie-equivalent token. It also refuses any
  // acting-account carrier, so a delegate cannot mint a credential against the
  // record they are helping with.
  const { user } = await requireAuth();
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
