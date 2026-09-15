import { apiError } from "@/lib/api-response";
import {
  checkRateLimit,
  rateLimitHeaders,
  refundRateLimit,
  type RateLimitResult,
} from "@/lib/rate-limit";

/**
 * The lab-report scan (`POST /api/labs/ocr/extract`, both the vision and the
 * browser-OCR text mode) charges one per-user hourly bucket. The ceiling is
 * operator-tunable via `LABS_OCR_LIMIT_PER_HOUR` (default 6, clamped to
 * 1-1000 so a typo can neither switch the scan off nor remove the cap), the
 * same posture as `DOCUMENT_AI_LIMIT_PER_HOUR` for the document vault. Unset or
 * non-numeric falls back to the default. Cost is bounded separately by the
 * daily AI budget; this bucket only bounds the request rate.
 */
const LABS_OCR_LIMIT_DEFAULT = 6;
const LABS_OCR_LIMIT_MIN = 1;
const LABS_OCR_LIMIT_MAX = 1000;

export function resolveLabsOcrLimitPerHour(): number {
  const raw = process.env.LABS_OCR_LIMIT_PER_HOUR;
  if (!raw) return LABS_OCR_LIMIT_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return LABS_OCR_LIMIT_DEFAULT;
  return Math.min(LABS_OCR_LIMIT_MAX, Math.max(LABS_OCR_LIMIT_MIN, parsed));
}

export const LABS_OCR_WINDOW_MS = 60 * 60 * 1000;
/** Bucket key prefix. Unchanged, so a running window survives the upgrade. */
export const LABS_OCR_BUCKET = "labs-ocr";

/** Charge one slot of the per-user lab-scan bucket. */
export async function checkLabsOcrRateLimit(
  userId: string,
): Promise<RateLimitResult> {
  return checkRateLimit(
    `${LABS_OCR_BUCKET}:${userId}`,
    resolveLabsOcrLimitPerHour(),
    LABS_OCR_WINDOW_MS,
  );
}

/**
 * Give a charged slot back when the scan failed BEFORE the provider was
 * called: a malformed body, a file that is too large or not an image or PDF,
 * a PDF that could not be rendered, or a daily budget that turned it away.
 * The bucket is charged early so a 429 stays cheap, but a slot must stand for
 * a scan that was actually sent. Best-effort: a failed refund never masks the
 * response the caller is about to return.
 */
export async function refundLabsOcrSlot(userId: string): Promise<void> {
  try {
    await refundRateLimit(`${LABS_OCR_BUCKET}:${userId}`);
  } catch {
    // The original response matters more than the bookkeeping.
  }
}

/**
 * The 429 for the lab-scan bucket. Carries the standard `X-RateLimit-*`
 * headers and mirrors the reset instant into `meta.retryAt` (ISO 8601) so the
 * client can name the actual wait.
 */
export function labsOcrRateLimited(rl: RateLimitResult): Response {
  const response = apiError("Too many scans. Try again later.", 429, {
    errorCode: "labs.ocr.rateLimited",
    retryAt: new Date(rl.resetAt).toISOString(),
  });
  for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
    response.headers.set(k, v);
  }
  return response;
}
