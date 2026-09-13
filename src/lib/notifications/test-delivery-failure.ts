import { apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import type { SendOutcome } from "@/lib/notifications/retry-policy";

/**
 * The code for an HTTP status a relay answered, in the test card's
 * vocabulary (`settings.testConnection.errors`). The same split the
 * Nightscout and wearable test routes use, plus two the relays need: a 3xx
 * (safeFetch never follows a redirect) and a 4xx that is not about the
 * credentials or the path, where the relay accepted the connection and
 * refused the payload.
 */
export function codeForUpstreamStatus(status: number): string {
  if (status === 401 || status === 403) return "credentials_rejected";
  if (status === 404 || status === 410) return "endpoint_not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_error";
  if (status >= 300 && status < 400) return "redirected";
  return "upstream_rejected";
}

export interface TestFailureDetail {
  /** Absent only for a failure the sender could not name: an internal fault. */
  errorCode?: string;
  upstreamStatus?: number;
  smtpCode?: number;
  upstreamBody?: string;
}

/** What a failed send outcome says, without the private-origin refusal. */
export function testFailureDetail(result: SendOutcome): TestFailureDetail {
  if (result.statusCode !== undefined) {
    return {
      errorCode: codeForUpstreamStatus(result.statusCode),
      upstreamStatus: result.statusCode,
      ...(result.upstreamBody ? { upstreamBody: result.upstreamBody } : {}),
    };
  }
  if (result.failureCode) {
    return {
      errorCode: result.failureCode,
      ...(result.smtpCode !== undefined ? { smtpCode: result.smtpCode } : {}),
    };
  }
  return {};
}

/** One English sentence for the envelope's `error`, the card translates the code. */
export function testFailureSentence(
  label: string,
  detail: TestFailureDetail,
): string {
  if (detail.upstreamStatus !== undefined) {
    return `${label} answered HTTP ${detail.upstreamStatus}.`;
  }
  const smtp =
    detail.smtpCode !== undefined ? ` (SMTP ${detail.smtpCode})` : "";
  switch (detail.errorCode) {
    case "timeout":
      return `${label} did not answer in time.`;
    case "connection_failed":
      return `Could not connect to ${label}.`;
    case "credentials_rejected":
      return `${label} rejected the credentials${smtp}.`;
    case "upstream_rejected":
      return `${label} refused the message${smtp}.`;
    case "upstream_error":
      return `${label} reported a temporary error${smtp}.`;
    default:
      return `${label} test failed.`;
  }
}

/**
 * The test routes' answer to a failed send that was not a private-origin
 * refusal (those keep their own 422 arm).
 *
 * The other end, or the way to it, failed: 502 with `meta.errorCode`, the
 * upstream status or SMTP code, and what the relay said when it is short
 * and holds no secret. A failure the sender could not name is an internal
 * fault and stays a 500 with `fallbackMessage`.
 */
export function answerTestDeliveryFailure(
  result: SendOutcome,
  opts: {
    channel: "webhook" | "ntfy" | "email";
    label: string;
    fallbackMessage: string;
  },
): Response {
  const detail = testFailureDetail(result);
  annotate({
    action: { name: `settings.${opts.channel}.test` },
    meta: {
      success: false,
      [`${opts.channel}_test_code`]: detail.errorCode ?? "internal",
      ...(detail.upstreamStatus !== undefined
        ? { [`${opts.channel}_test_status`]: detail.upstreamStatus }
        : {}),
      ...(detail.smtpCode !== undefined
        ? { [`${opts.channel}_test_smtp_code`]: detail.smtpCode }
        : {}),
    },
  });
  if (!detail.errorCode) {
    return apiError(opts.fallbackMessage, 500);
  }
  return apiError(testFailureSentence(opts.label, detail), 502, { ...detail });
}
