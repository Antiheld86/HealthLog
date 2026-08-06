/**
 * v1.17.1 — coverage for the operator-wide notification-health admin route.
 *
 * Pins:
 *   * 401 unauthenticated / 403 non-admin (requireAdmin is cookie-only),
 *   * the groupBy(channel, result) aggregate folds into per-channel
 *     ok/error/skipped/total rows,
 *   * auto-disabled channels (enabled=false + disabledReason not null) are
 *     surfaced with a count,
 *   * the window is clamped to 1..168 hours (default 24).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    pushAttempt: { groupBy: vi.fn() },
    notificationChannel: { groupBy: vi.fn() },
  },
}));

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return { ...actual, requireAdmin: vi.fn() };
});

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
  eventStorage: { run: <T>(_e: unknown, fn: () => Promise<T>) => fn() },
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { requireAdmin, HttpError } from "@/lib/api-handler";
import { NextRequest } from "next/server";

const ADMIN_CTX = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "admin-1", username: "admin", role: "ADMIN" },
} as never;

function req(hours?: string): NextRequest {
  const url = hours
    ? `http://localhost/api/admin/notifications/health?hours=${hours}`
    : "http://localhost/api/admin/notifications/health";
  return new NextRequest(url);
}

interface HealthEnvelope {
  data: {
    windowHours: number;
    channels: Array<{
      channel: string;
      ok: number;
      error: number;
      skipped: number;
      total: number;
    }>;
    autoDisabledChannels: Array<{ type: string; count: number }>;
  };
  error: string | null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.pushAttempt.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.notificationChannel.groupBy).mockResolvedValue([] as never);
});

describe("GET /api/admin/notifications/health — auth gates", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new HttpError(401, "Not authenticated"),
    );
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new HttpError(403, "Admin access required"),
    );
    const res = await GET(req());
    expect(res.status).toBe(403);
  });
});

describe("GET /api/admin/notifications/health — aggregate", () => {
  beforeEach(() => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
  });

  it("folds groupBy rows into per-channel ok/error/skipped/total", async () => {
    vi.mocked(prisma.pushAttempt.groupBy).mockResolvedValue([
      { channel: "NTFY", result: "ok", _count: { _all: 40 } },
      { channel: "NTFY", result: "error", _count: { _all: 12 } },
      { channel: "EMAIL", result: "ok", _count: { _all: 5 } },
      { channel: "EMAIL", result: "skipped", _count: { _all: 2 } },
    ] as never);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthEnvelope;

    const ntfy = body.data.channels.find((c) => c.channel === "NTFY");
    expect(ntfy).toEqual({
      channel: "NTFY",
      ok: 40,
      error: 12,
      skipped: 0,
      total: 52,
    });
    const email = body.data.channels.find((c) => c.channel === "EMAIL");
    expect(email).toEqual({
      channel: "EMAIL",
      ok: 5,
      error: 0,
      skipped: 2,
      total: 7,
    });
    // Sorted alphabetically.
    expect(body.data.channels.map((c) => c.channel)).toEqual(["EMAIL", "NTFY"]);
  });

  it("surfaces auto-disabled channels with a count", async () => {
    vi.mocked(prisma.notificationChannel.groupBy).mockResolvedValue([
      { type: "WEBHOOK", _count: { _all: 3 } },
    ] as never);

    const res = await GET(req());
    const body = (await res.json()) as HealthEnvelope;
    expect(body.data.autoDisabledChannels).toEqual([
      { type: "WEBHOOK", count: 3 },
    ]);
  });

  it("groups every delivery attempt in the selected window", async () => {
    await GET(req());
    const args = vi.mocked(prisma.pushAttempt.groupBy).mock.calls[0][0] as {
      where: { createdAt?: { gte?: Date } };
    };
    expect(args.where.createdAt?.gte).toBeInstanceOf(Date);
  });

  it("defaults the window to 24h and clamps out-of-range values", async () => {
    let res = await GET(req("999"));
    let body = (await res.json()) as HealthEnvelope;
    expect(body.data.windowHours).toBe(24);

    res = await GET(req("0"));
    body = (await res.json()) as HealthEnvelope;
    expect(body.data.windowHours).toBe(24);

    res = await GET(req("48"));
    body = (await res.json()) as HealthEnvelope;
    expect(body.data.windowHours).toBe(48);
  });
});
