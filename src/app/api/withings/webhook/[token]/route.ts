import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  applyWebhookRateLimit,
  processWithingsNotification,
  timingSafeStringEqual,
} from "@/lib/withings/webhook-handler";

/**
 * Withings webhook entrypoint (v1.4.25 W17a — path-segment secret).
 *
 * The shared secret travels in the URL path (`/api/withings/webhook/<secret>`)
 * rather than the query string. Withings has no facility for adding HTTP
 * headers or signing webhook bodies, so the only authenticity surface a
 * subscriber controls is the callback URL itself; moving the secret out of
 * the query string keeps it out of the `query_string` column most reverse
 * proxies log by default (Caddy, nginx, Coolify) and out of GlitchTip's
 * URL/breadcrumb capture path which already strips `?…` aggressively.
 *
 * The legacy `?secret=` form at `/api/withings/webhook` stays alive for one
 * release cycle so existing Withings subscriptions keep delivering while
 * users re-subscribe.
 */
interface RouteContext {
  params: Promise<{ token: string }>;
}

async function verifyTokenSegment(token: string | undefined): Promise<boolean> {
  const expected = process.env.WITHINGS_WEBHOOK_SECRET;
  if (!expected) {
    getEvent()?.addWarning("WITHINGS_WEBHOOK_SECRET not configured");
    return false;
  }
  if (!token) return false;
  return timingSafeStringEqual(expected, token);
}

export const POST = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    annotate({ action: { name: "withings.webhook" } });

    const limited = await applyWebhookRateLimit(request);
    if (limited) return limited;

    const { token } = await context.params;
    if (!(await verifyTokenSegment(token))) {
      return NextResponse.json({ status: "unauthorized" }, { status: 401 });
    }

    return processWithingsNotification(request);
  },
);

/**
 * Withings sends HEAD/GET to verify the URL when a subscription is
 * created.
 *
 * The verification verbs carry the same rate limit as the notification POST,
 * on the same bucket. They compare the same shared secret and answer 200
 * against 401, so without it they are a free oracle for guessing the token —
 * a constant-time comparison hides the timing channel, not the status code.
 */
export const HEAD = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    annotate({ action: { name: "withings.webhook.verify" } });

    // HEAD carries no body, so the limiter's JSON envelope is re-shaped into
    // a bodyless 429 that keeps the rate-limit headers.
    const limited = await applyWebhookRateLimit(request);
    if (limited) {
      return new NextResponse(null, { status: 429, headers: limited.headers });
    }

    const { token } = await context.params;
    if (!(await verifyTokenSegment(token))) {
      return new NextResponse(null, { status: 401 });
    }
    getEvent()?.setAuth({ auth_method: "webhook_secret" });
    return new NextResponse(null, { status: 200 });
  },
);

export const GET = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    annotate({ action: { name: "withings.webhook.verify" } });

    const limited = await applyWebhookRateLimit(request);
    if (limited) return limited;

    const { token } = await context.params;
    if (!(await verifyTokenSegment(token))) {
      return NextResponse.json({ status: "unauthorized" }, { status: 401 });
    }
    getEvent()?.setAuth({ auth_method: "webhook_secret" });
    return NextResponse.json({ status: "ok" }, { status: 200 });
  },
);
