/**
 * v1.11.0 (Epic C, C3) — share-token resolver, the security core.
 *
 * Asserts the load-bearing properties:
 *   - a valid, live token resolves to a ShareContext carrying ONLY the owner
 *     scope (no session/AuthContext fields);
 *   - revoked / expired / unknown / malformed tokens all resolve to `null`
 *     (the caller's blunt 404);
 *   - a successful resolve bumps the access counters fire-and-forget;
 *   - the resolver never reads a session and never sets a cookie.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    clinicianShareLink: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: (s: string) => `hash(${s})` }));

import { resolveShareToken } from "../resolve-share-token";
import { prisma } from "@/lib/db";

const findUnique = prisma.clinicianShareLink.findUnique as ReturnType<
  typeof vi.fn
>;
const update = prisma.clinicianShareLink.update as ReturnType<typeof vi.fn>;

const VALID_TOKEN = `hls_${"a".repeat(48)}`;

function liveRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    userId: "owner-1",
    label: "Cardiology",
    rangeStart: new Date("2026-01-01T00:00:00.000Z"),
    rangeEnd: null,
    sectionsJson: { bp: true },
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    ...overrides,
  };
}

describe("resolveShareToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    update.mockResolvedValue({});
  });

  it("resolves a live token to an owner-scoped context (no session fields)", async () => {
    findUnique.mockResolvedValue(liveRow());
    const ctx = await resolveShareToken(VALID_TOKEN);
    expect(ctx).not.toBeNull();
    expect(ctx?.ownerUserId).toBe("owner-1");
    expect(ctx?.shareLinkId).toBe("link-1");
    // The retired FHIR scope no longer rides the resolved context.
    expect(ctx).not.toHaveProperty("resourceTypes");
    expect(ctx).not.toHaveProperty("allowFhirApi");
    // The context must carry ONLY the owner scope — never a session/user/role.
    expect(ctx).not.toHaveProperty("session");
    expect(ctx).not.toHaveProperty("user");
    expect(ctx).not.toHaveProperty("role");
    // Looked up by the HMAC hash, never by plaintext.
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: `hash(${VALID_TOKEN})` } }),
    );
  });

  it("bumps access counters fire-and-forget on a successful resolve", async () => {
    findUnique.mockResolvedValue(liveRow());
    await resolveShareToken(VALID_TOKEN);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "link-1" },
        data: expect.objectContaining({ accessCount: { increment: 1 } }),
      }),
    );
  });

  it("returns null for an unknown token (no row)", async () => {
    findUnique.mockResolvedValue(null);
    expect(await resolveShareToken(VALID_TOKEN)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("returns null for a revoked token", async () => {
    findUnique.mockResolvedValue(liveRow({ revokedAt: new Date() }));
    expect(await resolveShareToken(VALID_TOKEN)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("returns null for an expired token", async () => {
    findUnique.mockResolvedValue(
      liveRow({ expiresAt: new Date(Date.now() - 1000) }),
    );
    expect(await resolveShareToken(VALID_TOKEN)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("returns null for a malformed token without touching the DB", async () => {
    expect(await resolveShareToken("bearer-or-garbage")).toBeNull();
    expect(await resolveShareToken("hls_short")).toBeNull();
    expect(await resolveShareToken("")).toBeNull();
    expect(await resolveShareToken(null)).toBeNull();
    expect(await resolveShareToken(undefined)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
