/**
 * The webhook payload format at the settings route (#947).
 *
 * Absent means generic, so a config saved before the choice existed keeps
 * sending the body it always sent. Only the Gotify choice is written, an
 * omitted format keeps the stored one, and the GET reports the resolved
 * value rather than leaving the client to guess the default.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    notificationChannel: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));
vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((value: string) => `encrypted:${value}`),
  decrypt: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 4,
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

import { GET, PUT } from "../webhook/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

type Route = (request: Request) => Promise<Response>;

function put(body: unknown): Promise<Response> {
  return (PUT as Route)(
    new Request("http://localhost/api/settings/webhook", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function get(): Promise<Response> {
  return (GET as Route)(new Request("http://localhost/api/settings/webhook"));
}

function stored(): string {
  const call = vi.mocked(prisma.notificationChannel.upsert).mock.calls[0][0];
  return call.create.config as string;
}

function existing(config: Record<string, unknown>) {
  vi.mocked(prisma.notificationChannel.findUnique).mockResolvedValue({
    enabled: true,
    config: `encrypted:${JSON.stringify(config)}`,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.notificationChannel.findUnique).mockResolvedValue(
    null as never,
  );
  vi.mocked(prisma.notificationChannel.upsert).mockResolvedValue({} as never);
});

describe("PUT /api/settings/webhook — payload format", () => {
  it("stores the Gotify choice", async () => {
    const response = await put({
      url: "https://gotify.example.com/message",
      headerName: "X-Gotify-Key",
      headerValue: "AbCdEfGh123",
      format: "gotify",
      enabled: true,
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(stored().replace(/^encrypted:/, ""))).toEqual({
      url: "https://gotify.example.com/message",
      headerName: "X-Gotify-Key",
      headerValue: "AbCdEfGh123",
      format: "gotify",
    });
  });

  it("writes nothing for generic, so the stored config keeps its old shape", async () => {
    await put({
      url: "https://relay.example.com/hook",
      format: "generic",
      enabled: true,
    });

    expect(stored()).toBe('encrypted:{"url":"https://relay.example.com/hook"}');
  });

  it("keeps a stored Gotify choice when the body omits the field", async () => {
    existing({
      url: "https://gotify.example.com/message",
      headerValue: "AbCdEfGh123",
      format: "gotify",
    });

    await put({
      url: "https://gotify.example.com/message",
      headerValue: "NewToken456",
      enabled: true,
    });

    expect(JSON.parse(stored().replace(/^encrypted:/, ""))).toMatchObject({
      headerValue: "NewToken456",
      format: "gotify",
    });
  });

  it("switches a Gotify channel back to generic when asked", async () => {
    existing({ url: "https://gotify.example.com/message", format: "gotify" });

    await put({
      url: "https://gotify.example.com/message",
      format: "generic",
      enabled: true,
    });

    expect(stored()).toBe(
      'encrypted:{"url":"https://gotify.example.com/message"}',
    );
  });

  it("refuses a format it does not know", async () => {
    const response = await put({
      url: "https://relay.example.com/hook",
      format: "discord",
      enabled: true,
    });

    expect(response.status).toBe(422);
    expect(prisma.notificationChannel.upsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/settings/webhook — payload format", () => {
  it("reports generic for a config saved before the choice existed", async () => {
    existing({ url: "https://relay.example.com/hook" });

    const json = await (await get()).json();

    expect(json.data.format).toBe("generic");
  });

  it("reports the stored Gotify choice", async () => {
    existing({ url: "https://gotify.example.com/message", format: "gotify" });

    const json = await (await get()).json();

    expect(json.data.format).toBe("gotify");
  });

  it("reports generic when no channel exists", async () => {
    const json = await (await get()).json();

    expect(json.data).toEqual({
      enabled: false,
      url: "",
      headerName: "",
      hasHeaderValue: false,
      format: "generic",
    });
  });
});
