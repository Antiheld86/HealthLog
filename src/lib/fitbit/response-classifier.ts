/**
 * Off-response classifier for Fitbit / Google Health API replies (v1.12.0).
 *
 * Like WHOOP, Google signals failure through the HTTP status code itself (no
 * `status` field embedded in a 200 body), so the classification is
 * status-driven. The shared core lives in
 * `src/lib/integrations/http-status-classifier.ts`; this module re-exports it
 * under the Fitbit-specific names callers already use.
 *
 *   - `success`         → HTTP 2xx
 *   - `transient`       → retryable: HTTP 429 (rate-limited — honour
 *                         `Retry-After` for backoff at the call site), 5xx
 *                         upstream outages, 3xx CDN/network glitches, and an
 *                         unknown status where we never reached the envelope.
 *   - `reauth_required` → HTTP 401 / 403 — the access token is rejected or the
 *                         grant was revoked; the user must redo OAuth. (The
 *                         per-data-class 403 soft-skip lives in `sync.ts`'s
 *                         `isCollectionForbidden`, not here, so a Restricted
 *                         scope granted independently doesn't park the whole
 *                         connection.)
 *   - `persistent`      → any other 4xx (400, 404, 422, …) — a malformed
 *                         request or a contract mismatch that retrying without
 *                         operator intervention will not fix.
 *
 * Unlike WHOOP, there is no `invalid_grant` token-body special-case: Google
 * signals a revoked refresh token with a 401 on the token endpoint, which the
 * status-driven classifier already buckets as `reauth_required`.
 */

import {
  classifyHttpStatus,
  classifyIntegrationError,
  IntegrationApiError,
  type ClassifiedHttpResponse,
  type IntegrationClassification,
} from "@/lib/integrations/http-status-classifier";

/** Outcome buckets for a Fitbit response. */
export type FitbitClassification = IntegrationClassification;

export type ClassifiedFitbitResponse = ClassifiedHttpResponse;

/** Classify a single Fitbit / Google Health API response by its HTTP status. */
export function classifyFitbitResponse(
  httpStatus: number,
): ClassifiedFitbitResponse {
  return classifyHttpStatus(httpStatus);
}

/**
 * Typed error carrying the classification verdict so downstream `try/catch`
 * blocks can branch without re-parsing the message. Extends the shared base
 * (message shape `Fitbit <verb> error: <status>` is preserved).
 */
export class FitbitApiError extends IntegrationApiError {
  /**
   * The `Retry-After` delay (seconds) the upstream asked for on a 429, when it
   * sent the delay-seconds form. Undefined on every other status, on a missing
   * header, and on the HTTP-date form. `fitbitGet` waits out a value inside
   * `FITBIT_RETRY_AFTER_WAIT_CAP_S` and retries once; anything larger fails
   * fast and surfaces here so the wide event records what was asked.
   */
  readonly retryAfterSeconds: number | undefined;

  constructor(opts: {
    verb: string;
    classification: FitbitClassification;
    httpStatus: number | undefined;
    reason: string;
    upstreamError?: string;
    retryAfterSeconds?: number;
  }) {
    const { retryAfterSeconds, ...base } = opts;
    super({ vendor: "Fitbit", ...base });
    this.name = "FitbitApiError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Read the classification from any caught error. Returns `transient` for a
 * non-`FitbitApiError` input so a call site surfacing a plain `Error` retries
 * rather than permanently disabling the integration. Falls back to parsing the
 * HTTP status out of the legacy `"Fitbit <verb> error: <status>"` message shape
 * for callers that lose the original prototype across a pg-boss retry.
 */
export function classifyFitbitError(err: unknown): FitbitClassification {
  return classifyIntegrationError(err, "Fitbit");
}
