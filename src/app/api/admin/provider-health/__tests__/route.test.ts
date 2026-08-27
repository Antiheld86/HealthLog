/**
 * v1.37.31 — contract for the operator provider-health readout
 * (`/api/admin/provider-health`). The per-user retry ledger existed for a
 * long time with no operator surface; this pins the fold: one row per
 * provider type, failing counted from the LAST result only, the worst
 * uninterrupted failure run taken across failing users, central types
 * sorted first, and no per-user data in the response.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    providerHealth: {
      groupBy: vi.fn(),
    },
  },
}));

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(
      h: T,
    ): T => h,
    requireAdmin: vi.fn(),
  };
});

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/api-handler";

const groupBy = vi.mocked(prisma.providerHealth.groupBy);

function group(
  providerType: string,
  lastResult: string,
  count: number,
  max: {
    consecutiveFailures?: number;
    lastFailureAt?: Date | null;
    lastOkAt?: Date | null;
  } = {},
) {
  return {
    providerType,
    lastResult,
    _count: { _all: count },
    _max: {
      consecutiveFailures: max.consecutiveFailures ?? 0,
      lastFailureAt: max.lastFailureAt ?? null,
      lastOkAt: max.lastOkAt ?? null,
    },
  };
}

describe("GET /api/admin/provider-health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin1" },
    } as never);
  });

  it("is admin-gated before it touches the ledger", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("forbidden"));

    await expect(GET()).rejects.toThrow("forbidden");
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("folds ok and failing groups of one type into a single row", async () => {
    groupBy.mockResolvedValue([
      group("admin-openai", "ok", 3, {
        lastOkAt: new Date("2026-08-27T07:00:00Z"),
      }),
      group("admin-openai", "hard_failed", 2, {
        consecutiveFailures: 3334,
        lastFailureAt: new Date("2026-08-27T06:00:00Z"),
      }),
    ] as never);

    const res = await GET();
    const body = await res.json();
    expect(body.data.providers).toEqual([
      {
        providerType: "admin-openai",
        tracked: 5,
        failing: 2,
        maxConsecutiveFailures: 3334,
        lastOkAt: "2026-08-27T07:00:00.000Z",
        lastFailureAt: "2026-08-27T06:00:00.000Z",
      },
    ]);
  });

  it("counts auth_failed as failing and keeps an all-ok type at zero", async () => {
    groupBy.mockResolvedValue([
      group("codex", "auth_failed", 1, { consecutiveFailures: 7 }),
      group("local", "ok", 4),
    ] as never);

    const res = await GET();
    const body = await res.json();
    const byType = Object.fromEntries(
      body.data.providers.map(
        (p: { providerType: string; failing: number }) => [
          p.providerType,
          p.failing,
        ],
      ),
    );
    expect(byType).toEqual({ codex: 1, local: 0 });
  });

  it("sorts the operator-managed types first, the rest alphabetically", async () => {
    groupBy.mockResolvedValue([
      group("local", "ok", 1),
      group("anthropic", "ok", 1),
      group("admin-codex", "ok", 1),
      group("admin-openai", "ok", 1),
    ] as never);

    const res = await GET();
    const body = await res.json();
    expect(
      body.data.providers.map((p: { providerType: string }) => p.providerType),
    ).toEqual(["admin-openai", "admin-codex", "anthropic", "local"]);
  });

  it("answers an empty ledger with an empty list, not an error", async () => {
    groupBy.mockResolvedValue([] as never);

    const res = await GET();
    const body = await res.json();
    expect(body.data.providers).toEqual([]);
  });
});
