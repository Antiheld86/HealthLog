import type { WideEvent } from "./types";
import { getLoggingConfig } from "./config";
import { shouldEmit } from "./sampler";
import { appendLogEvent } from "./in-memory-buffer";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";
import { canonicalOrigin } from "@/lib/private-origin-policy";

/** Event auf stdout als einzelne JSON-Zeile schreiben */
function emitToStdout(event: WideEvent): void {
  const config = getLoggingConfig();
  const json = config.prettyPrint
    ? JSON.stringify(event, null, 2)
    : JSON.stringify(event);
  process.stdout.write(json + "\n");
}

// Loki Push API Buffer
const LOKI_MAX_BUFFER_SIZE = 1000;
let lokiBuffer: WideEvent[] = [];
let lokiFlushTimer: ReturnType<typeof setInterval> | null = null;

function initLokiTransport(): void {
  const config = getLoggingConfig();
  if (!config.lokiEndpoint || lokiFlushTimer) return;

  lokiFlushTimer = setInterval(() => {
    flushLokiBuffer().catch((err) => {
      process.stderr.write(`[logging] Loki flush error: ${err}\n`);
    });
  }, 5000);

  if (lokiFlushTimer.unref) lokiFlushTimer.unref();
}

const LOKI_PUSH_PATH = "/loki/api/v1/push";
const LOKI_PUSH_TIMEOUT_MS = 10_000;

export interface LokiPushTarget {
  /** The URL the batch is POSTed to. */
  url: string;
  /**
   * The exact origin handed to `safeFetch` as the operator approval. Also the
   * only part of the endpoint that ever appears in a failure line: it carries
   * no userinfo, path or query by construction.
   */
  origin: string;
}

export type LokiTargetResolution =
  | { ok: true; target: LokiPushTarget }
  | {
      ok: false;
      reason: "invalid_endpoint" | "never_grantable";
      shown: string;
    };

/**
 * Turn `LOKI_ENDPOINT` into the push URL and the origin it may dial.
 *
 * Both spellings an operator reaches for work: the base URL
 * (`http://loki:3100`, the push path is appended) and the full push URL
 * (`http://loki:3100/loki/api/v1/push`, used as is, trailing slash or not).
 * Appending unconditionally turned the second form into
 * `/loki/api/v1/push/loki/api/v1/push` and a 404.
 *
 * Why the endpoint dials as an operator-approved origin rather than through
 * the public-host pin: `LOKI_ENDPOINT` is read from the server environment in
 * `config.ts` and nowhere else. No request field, settings row or admin form
 * can set it, so there is no user-supplied host to defend against, and the
 * public-only pin was refusing the common deployment (a Loki on the same LAN
 * or Docker network) without a word. The exact origin still goes through the
 * pinned operator resolver in `safeFetch` with redirects forbidden, and the
 * never-grantable floor holds: an endpoint whose literal host is the
 * unspecified address, link-local or the metadata range is refused here
 * (`canonicalOrigin`), and a name that resolves there is dropped at dial time.
 */
export function resolveLokiPushTarget(endpoint: string): LokiTargetResolution {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return { ok: false, reason: "invalid_endpoint", shown: "(unparseable)" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "invalid_endpoint", shown: url.protocol };
  }
  // `url.origin` never carries userinfo, so it is safe to print even when
  // the endpoint itself is refused for carrying credentials.
  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, reason: "invalid_endpoint", shown: url.origin };
  }
  const origin = canonicalOrigin(url.origin);
  if (!origin) {
    return { ok: false, reason: "never_grantable", shown: url.origin };
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  const pushPath = basePath.endsWith(LOKI_PUSH_PATH)
    ? basePath
    : `${basePath}${LOKI_PUSH_PATH}`;
  return { ok: true, target: { url: `${origin}${pushPath}`, origin } };
}

/**
 * Failure notices for the Loki push, written straight to stderr.
 *
 * Never through `emitEvent`: a failing Loki push that reported itself as a
 * wide event would buffer that event for the same failing push. At most one
 * line per reason per window, so a Loki that is down for an hour costs twelve
 * lines, not seven hundred. Events dropped while a reason is quiet are counted
 * and reported on its next line, so the numbers add up.
 */
export const LOKI_FAILURE_NOTICE_INTERVAL_MS = 5 * 60 * 1000;
const lokiFailureNotices = new Map<
  string,
  { lastAt: number; droppedSinceLast: number }
>();

function reportLokiFailure(
  shownEndpoint: string,
  reason: string,
  droppedEvents: number,
): void {
  const now = Date.now();
  const entry = lokiFailureNotices.get(reason);
  if (entry && now - entry.lastAt < LOKI_FAILURE_NOTICE_INTERVAL_MS) {
    entry.droppedSinceLast += droppedEvents;
    return;
  }
  const dropped = droppedEvents + (entry?.droppedSinceLast ?? 0);
  lokiFailureNotices.set(reason, { lastAt: now, droppedSinceLast: 0 });
  process.stderr.write(
    `[logging] Loki push to ${shownEndpoint} failed (${reason}); ` +
      `${dropped} event${dropped === 1 ? "" : "s"} dropped. ` +
      `Repeats of this failure are reported at most every 5 minutes.\n`,
  );
}

/**
 * The failure reason as a short class, never the error message: messages
 * from the fetch stack can embed the target URL, and this line goes to stderr
 * unredacted. A socket error code (`ECONNREFUSED`, `ENOTFOUND`) is kept
 * because it is the part that tells an operator what to fix.
 */
function classifyLokiError(err: unknown): string {
  const kind = err instanceof SafeFetchError ? err.kind : "error";
  let cause: unknown = err instanceof SafeFetchError ? err.cause : err;
  for (
    let depth = 0;
    depth < 4 && cause && typeof cause === "object";
    depth++
  ) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) {
      return `${kind} ${code}`;
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return kind;
}

export async function flushLokiBuffer(): Promise<void> {
  if (lokiBuffer.length === 0) return;
  const config = getLoggingConfig();
  if (!config.lokiEndpoint) return;

  const batch = lokiBuffer;
  lokiBuffer = [];

  const resolved = resolveLokiPushTarget(config.lokiEndpoint);
  if (!resolved.ok) {
    reportLokiFailure(resolved.shown, resolved.reason, batch.length);
    return;
  }
  const { target } = resolved;

  const streams = [
    {
      stream: {
        service: "healthlog",
        environment: batch[0]?.environment || "production",
      },
      values: batch.map((event) => [
        // Loki erwartet Nanosekunden-Timestamp als String
        new Date(event.timestamp).getTime() + "000000",
        JSON.stringify(event),
      ]),
    },
  ];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.lokiUsername && config.lokiPassword) {
    headers["Authorization"] =
      "Basic " +
      Buffer.from(`${config.lokiUsername}:${config.lokiPassword}`).toString(
        "base64",
      );
  }

  let res: Response;
  try {
    res = await safeFetch(
      target.url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ streams }),
      },
      // Operator-configured endpoint: dial exactly its origin through the
      // pinned operator resolver (see `resolveLokiPushTarget`).
      {
        timeoutMs: LOKI_PUSH_TIMEOUT_MS,
        operatorApprovedPrivateOrigin: target.origin,
      },
    );
  } catch (err) {
    // The batch is already detached from the buffer; say so rather than
    // losing it without a trace.
    reportLokiFailure(target.origin, classifyLokiError(err), batch.length);
    return;
  }

  // Loki answers 204. Anything else, including a 3xx the forbidden redirect
  // left unfollowed, means the batch did not land.
  if (!res.ok) {
    reportLokiFailure(target.origin, `HTTP ${res.status}`, batch.length);
  }
  await res.body?.cancel().catch(() => {});
}

/** Test helper: clear the buffer and the failure-notice windows. */
export function _resetLokiTransportForTests(): void {
  lokiBuffer = [];
  lokiFailureNotices.clear();
}

/**
 * Event emittieren falls Sampling-Kriterien erfuellt.
 * Zentraler Einstiegspunkt — entfernt Stack Traces falls konfiguriert.
 */
export function emitIfSampled(event: WideEvent): void {
  const config = getLoggingConfig();
  if (!config.includeStackTrace && event.error?.stack) {
    delete event.error.stack;
  }
  if (shouldEmit(event)) {
    emitEvent(event);
  }
}

/** Zentraler Emit: stdout + optional Loki-Buffer + in-memory ring buffer */
export function emitEvent(event: WideEvent): void {
  emitToStdout(event);

  // Push into the per-process in-memory ring buffer so admins can drill
  // into the most recent ~500 wide events from the `/admin/app-logs`
  // page without standing up a Loki stack. See `in-memory-buffer.ts`.
  // Wrapped in try/catch so a buffer bug never poisons the request.
  try {
    appendLogEvent(event);
  } catch {
    /* logging must never crash the handler */
  }

  const config = getLoggingConfig();
  if (config.lokiEndpoint) {
    initLokiTransport();
    if (lokiBuffer.length >= LOKI_MAX_BUFFER_SIZE) {
      lokiBuffer.shift();
    }
    lokiBuffer.push(event);
  }
}
