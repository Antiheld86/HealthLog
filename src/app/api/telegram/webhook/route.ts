import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-response";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  handleCallback,
  handleTextMessage,
  type TelegramUpdate,
} from "@/lib/telegram-webhook-handlers";

/**
 * Telegram bot webhook. Thin shell over
 * `@/lib/telegram-webhook-handlers`: per-source rate limit FIRST, then
 * the shared-secret check (constant-time compare), then a bounded JSON
 * parse, then dispatch to the callback / free-text handlers. Invalid
 * payloads acknowledge with 200 so Telegram does not retry-loop them.
 */

function hasValidSecret(request: NextRequest): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    getEvent()?.addWarning("TELEGRAM_WEBHOOK_SECRET not configured");
    return false;
  }
  const received = request.headers.get("x-telegram-bot-api-secret-token");
  if (!received) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The per-source limit both verbs share, on one bucket. It runs before the
 * secret comparison on every verb that performs one: the comparison answers
 * 200 against 401, and a constant-time compare hides the timing channel but
 * not the status code, so the limiter is what makes guessing expensive.
 */
async function applyWebhookRateLimit(
  request: NextRequest,
): Promise<NextResponse | null> {
  const ip = getClientIp(request);
  const rl = await checkRateLimit(`telegram-webhook:${ip}`, 120, 60 * 1000);
  if (rl.allowed) return null;
  return NextResponse.json(
    { status: "rate_limited" },
    { status: 429, headers: rateLimitHeaders(rl) },
  );
}

export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "telegram.webhook" } });

  const limited = await applyWebhookRateLimit(request);
  if (limited) return limited;

  if (!hasValidSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }

  getEvent()?.setAuth({ auth_method: "telegram_webhook" });

  let update: TelegramUpdate;
  try {
    const raw = await request.text();
    if (raw.length > 256 * 1024) {
      // Oversized payload — acknowledge with 200 like invalid JSON so the
      // sender does not retry-loop the update.
      return NextResponse.json({ status: "invalid json" }, { status: 200 });
    }
    update = JSON.parse(raw) as TelegramUpdate;
  } catch {
    return NextResponse.json({ status: "invalid json" }, { status: 200 });
  }
  if (!update || typeof update.update_id !== "number") {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  annotate({ meta: { update_id: update.update_id } });

  if (update.callback_query) {
    await handleCallback(update);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  if (update.message?.text) {
    await handleTextMessage(update);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  return NextResponse.json({ status: "ignored" }, { status: 200 });
});

export const GET = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "telegram.webhook.verify" } });

  const limited = await applyWebhookRateLimit(request);
  if (limited) return limited;

  if (!hasValidSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }
  getEvent()?.setAuth({ auth_method: "telegram_webhook" });
  return NextResponse.json({ status: "ok" }, { status: 200 });
});
