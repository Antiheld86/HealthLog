/**
 * v1.4.43 W6 — multi-issue 422 envelope on PUT /api/user/thresholds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));
// The thresholds validator imports METRIC_BOUNDS at module top-level
// to build its strict-object schema, so we need to keep the real export
// surface around when we mock the module.
vi.mock("@/lib/analytics/effective-range", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/analytics/effective-range")>();
  return {
    ...actual,
    getAllEffectiveRanges: vi.fn().mockReturnValue({}),
  };
});
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PUT } from "../route";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { getAllEffectiveRanges } from "@/lib/analytics/effective-range";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function putReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/user/thresholds", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("PUT /api/user/thresholds — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // WEIGHT bounds are min=30, max=300. Sending min > max + a value
    // out of bounds on PULSE forces two range errors.
    const res = await PUT(
      putReq({
        WEIGHT: { min: 100, max: 50 }, // refine min < max
        PULSE: { min: 1000, max: 2000 }, // out of bounds
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    const res = await PUT(
      putReq({
        WEIGHT: { min: 100, max: 50 },
        PULSE: { min: 1000, max: 2000 },
        BODY_FAT: { min: 999, max: 1000 },
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * The docblock promised a key the handler has never returned.
 *
 * For as long as this route has existed its header said GET answers
 * `{ defaults, overrides, effective }`. It answers `{ effective, overrides }`;
 * the per-metric defaults live inside `effective[metric].default`. Anyone
 * reading the file to find out what to decode was told to expect a top-level
 * key that is not there.
 *
 * Asserting the shape alone would not have caught it — the code was always
 * right. So this compares the two: the keys the response actually carries
 * against the keys the docblock advertises. A comment that drifts from the
 * handler fails here, in either direction.
 */
describe("GET /api/user/thresholds — the docblock describes the response", () => {
  const RESPONSE_KEYS = ["effective", "overrides"];

  it("returns exactly the documented top-level keys", async () => {
    // `beforeEach` calls `vi.resetAllMocks()`, which clears the module-level
    // `mockReturnValue({})` — without re-arming it the resolver returns
    // undefined and `effective` vanishes from the JSON entirely.
    vi.mocked(getAllEffectiveRanges).mockReturnValue({
      WEIGHT: {
        range: { greenMin: 60, greenMax: 80, orangeMin: 57, orangeMax: 83 },
        isOverride: false,
        default: { greenMin: 60, greenMax: 80, orangeMin: 57, orangeMax: 83 },
        bounds: { min: 30, max: 300, unit: "kg" },
      },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: 180,
      dateOfBirth: null,
      gender: null,
      thresholdsJson: null,
    } as never);

    const res = await (GET as unknown as () => Promise<Response>)();
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual([...RESPONSE_KEYS].sort());
    expect(body.data).not.toHaveProperty("defaults");
  });

  it("names those same keys in the route's own header comment", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "src/app/api/user/thresholds/route.ts"),
      "utf8",
    );
    const docblock = source.slice(0, source.indexOf("*/"));

    // The promise the header makes, as a brace list: `{ effective, overrides }`.
    const promised = docblock.match(/GET returns `\{([^}]+)\}`/);
    expect(
      promised,
      "the header no longer states what GET returns",
    ).not.toBeNull();

    const promisedKeys = (promised?.[1] ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean)
      .sort();

    expect(promisedKeys).toEqual([...RESPONSE_KEYS].sort());
  });
});
