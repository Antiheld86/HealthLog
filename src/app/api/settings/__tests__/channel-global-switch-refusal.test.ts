/**
 * Enabling a channel the operator switched off instance-wide is refused.
 *
 * The three switches (`AppSettings.telegramGlobal` / `.ntfyGlobal` /
 * `.webPushGlobal`) now stop delivery in the dispatcher. Without a matching
 * refusal on the way in, a user would still see the toggle flip, the row
 * would still say `enabled = true`, and nothing would ever arrive. These
 * tests pin the refusal and the absence of any write behind it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn() },
    notificationChannel: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    pushSubscription: { upsert: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((value: string) => `encrypted:${value}`),
  decrypt: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
}));

const setTelegramWebhookMock = vi.fn().mockResolvedValue(true);
vi.mock("@/lib/telegram", () => ({
  setTelegramWebhook: (...args: unknown[]) => setTelegramWebhookMock(...args),
  deleteTelegramWebhook: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: () => ({}),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { PUT as putNtfy } from "../ntfy/route";
import { PUT as putTelegram } from "../telegram/route";
import { POST as postWebPush } from "../../notifications/web-push/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

const WEB_PUSH_SUBSCRIPTION = {
  endpoint: "https://push.example.com/subscription/abc",
  keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
};

function stubSettings(over: Record<string, boolean>) {
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
    telegramGlobal: true,
    ntfyGlobal: true,
    webPushGlobal: true,
    apiGlobal: true,
    ...over,
  } as never);
}

function request(path: string, method: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.notificationChannel.updateMany).mockResolvedValue({
    count: 1,
  } as never);
  vi.mocked(prisma.notificationChannel.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.notificationChannel.findUnique).mockResolvedValue({
    config: 'encrypted:{"serverUrl":"https://ntfy.sh","topic":"saved-topic"}',
  } as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    telegramBotToken: "encrypted:saved-token",
    telegramChatId: "saved-chat",
    telegramEnabled: false,
  } as never);
  vi.mocked(prisma.user.update).mockResolvedValue({} as never);
  vi.mocked(prisma.pushSubscription.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.notificationChannel.findFirst).mockResolvedValue(null);
});

describe("ntfy enable against the instance-wide switch", () => {
  it("refuses with 403 and writes nothing when the operator switched ntfy off", async () => {
    stubSettings({ ntfyGlobal: false });

    const response = await putNtfy(
      request("/api/settings/ntfy", "PUT", { enabled: true }) as never,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      data: null,
      error: expect.stringContaining("disabled on this instance"),
    });
    expect(prisma.notificationChannel.updateMany).not.toHaveBeenCalled();
    expect(prisma.notificationChannel.upsert).not.toHaveBeenCalled();
  });

  it("still allows disabling the channel while the switch is off", async () => {
    stubSettings({ ntfyGlobal: false });

    const response = await putNtfy(
      request("/api/settings/ntfy", "PUT", { enabled: false }) as never,
    );

    expect(response.status).toBe(200);
    expect(prisma.notificationChannel.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", type: "NTFY" },
      data: { enabled: false },
    });
  });

  it("allows enabling while the switch is on", async () => {
    stubSettings({ ntfyGlobal: true });

    const response = await putNtfy(
      request("/api/settings/ntfy", "PUT", { enabled: true }) as never,
    );

    expect(response.status).toBe(200);
    expect(prisma.notificationChannel.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", type: "NTFY" },
      data: { enabled: true },
    });
  });
});

describe("Telegram enable against the instance-wide switch", () => {
  it("refuses with 403, registers no webhook, and writes nothing", async () => {
    stubSettings({ telegramGlobal: false });

    const response = await putTelegram(
      request("/api/settings/telegram", "PUT", { enabled: true }) as never,
    );

    expect(response.status).toBe(403);
    expect(setTelegramWebhookMock).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.notificationChannel.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a full-config save that enables the channel", async () => {
    stubSettings({ telegramGlobal: false });

    const response = await putTelegram(
      request("/api/settings/telegram", "PUT", {
        botToken: "123456:AAaaBBbbCCccDDddEEeeFFffGGgg-HHhhIIii",
        chatId: "9876543",
        enabled: true,
      }) as never,
    );

    expect(response.status).toBe(403);
    expect(setTelegramWebhookMock).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("Web Push subscribe against the instance-wide switch", () => {
  it("refuses with 403 and stores no subscription", async () => {
    stubSettings({ webPushGlobal: false });

    const response = await postWebPush(
      request(
        "/api/notifications/web-push",
        "POST",
        WEB_PUSH_SUBSCRIPTION,
      ) as never,
    );

    expect(response.status).toBe(403);
    expect(prisma.pushSubscription.upsert).not.toHaveBeenCalled();
    expect(prisma.notificationChannel.create).not.toHaveBeenCalled();
  });

  it("stores the subscription while the switch is on", async () => {
    stubSettings({ webPushGlobal: true });

    const response = await postWebPush(
      request(
        "/api/notifications/web-push",
        "POST",
        WEB_PUSH_SUBSCRIPTION,
      ) as never,
    );

    expect(response.status).toBe(200);
    expect(prisma.pushSubscription.upsert).toHaveBeenCalledTimes(1);
  });
});
